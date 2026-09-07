import type { ModelStack } from "./model-stack.ts";
import {
	createAutonomousState,
	isTerminalPhase,
	routeAutonomousDecision,
	transitionAutonomousState,
	wallClockExceeded,
	type AutonomousCompletionAssessment,
	type AutonomousCycleRecord,
	type AutonomousDecision,
	type AutonomousExecutionResult,
	type AutonomousLimits,
	type AutonomousMode,
	type AutonomousObservation,
	type AutonomousPlan,
	type AutonomousRunState,
	type AutonomousValidationResult,
	type HumanRequiredDetail,
} from "./autonomous-state.ts";

export class AutonomousHumanRequiredError extends Error {
	constructor(public detail: HumanRequiredDetail) {
		super(detail.reason);
		this.name = "AutonomousHumanRequiredError";
	}
}

export interface AutonomousControllerDeps {
	stack: ModelStack;
	signal?: AbortSignal;
	now?: () => number;
	observe(state: AutonomousRunState, cycle: AutonomousCycleRecord): Promise<AutonomousObservation>;
	decide(state: AutonomousRunState, cycle: AutonomousCycleRecord, observation: AutonomousObservation): Promise<AutonomousDecision>;
	execute(state: AutonomousRunState, cycle: AutonomousCycleRecord, decision: AutonomousDecision, plan: AutonomousPlan): Promise<AutonomousExecutionResult>;
	validate(state: AutonomousRunState, cycle: AutonomousCycleRecord, observation: AutonomousObservation, execution: AutonomousExecutionResult): Promise<AutonomousValidationResult>;
	review(
		state: AutonomousRunState,
		cycle: AutonomousCycleRecord,
		observation: AutonomousObservation,
		decision: AutonomousDecision,
		plan: AutonomousPlan,
		execution: AutonomousExecutionResult,
		validation: AutonomousValidationResult,
	): Promise<AutonomousCompletionAssessment>;
	persist(state: AutonomousRunState): Promise<void>;
	onUpdate?(state: AutonomousRunState): void;
}

const skippedValidation = (reason: string): AutonomousValidationResult => ({ ok: false, commands: [], failures: [reason] });

export async function runAutonomousController(
	goal: string,
	mode: AutonomousMode,
	limits: AutonomousLimits,
	deps: AutonomousControllerDeps,
): Promise<AutonomousRunState> {
	const now = deps.now ?? Date.now;
	let state = createAutonomousState(goal, mode, limits, now());

	const publish = async () => {
		state.updatedAt = now();
		deps.onUpdate?.(state);
		await deps.persist(state);
	};
	const move = async (phase: AutonomousRunState["phase"]) => {
		state = transitionAutonomousState(state, phase, now());
		const current = state.cycles[state.cycles.length - 1];
		if (current && !isTerminalPhase(phase)) current.phase = phase;
		await publish();
	};
	const humanRequired = async (detail: HumanRequiredDetail, reason: AutonomousRunState["stopReason"] = "human-required") => {
		if (!isTerminalPhase(state.phase)) state = transitionAutonomousState(state, "HUMAN_REQUIRED", now());
		state.humanRequired = detail;
		state.stopReason = reason;
		const current = state.cycles[state.cycles.length - 1];
		if (current) {
			current.phase = "HUMAN_REQUIRED";
			current.endedAt ??= now();
		}
		await publish();
	};
	const stopped = async (reason: AutonomousRunState["stopReason"], failure?: string) => {
		if (!isTerminalPhase(state.phase)) state = transitionAutonomousState(state, "STOPPED", now());
		state.stopReason = reason;
		const current = state.cycles[state.cycles.length - 1];
		if (current) {
			current.phase = "STOPPED";
			current.failure ??= failure;
			current.endedAt ??= now();
		}
		await publish();
	};
	const cancelled = async (): Promise<boolean> => {
		if (!deps.signal?.aborted) return false;
		await stopped("cancelled", "stopped by user");
		return true;
	};
	const checkWallClock = async (): Promise<boolean> => {
		if (!wallClockExceeded(state, now())) return false;
		await humanRequired(
			{
				reason: `Autonomous wall-clock limit reached after ${Math.round((now() - state.startedAt) / 1000)} seconds.`,
				question: "Increase the autonomous wall-clock limit or narrow the goal?",
				options: ["Increase the limit", "Narrow the goal", "Stop here"],
			},
			"wall-clock-limit",
		);
		return true;
	};

	await publish();
	while (!isTerminalPhase(state.phase)) {
		if (await cancelled()) break;
		if (await checkWallClock()) break;
		if (state.cycle >= state.limits.maxCycles) {
			await humanRequired(
				{
					reason: `Autonomous cycle limit reached (${state.limits.maxCycles}).`,
					question: "Increase max cycles, refine the goal, or stop?",
					options: ["Increase max cycles", "Refine the goal", "Stop here"],
				},
				"max-cycles",
			);
			break;
		}

		const cycle: AutonomousCycleRecord = { cycle: state.cycle + 1, phase: "OBSERVE", startedAt: now() };
		state = { ...state, cycle: cycle.cycle, cycles: [...state.cycles, cycle], phase: "OBSERVE", updatedAt: now() };
		await publish();

		let observation: AutonomousObservation;
		try {
			observation = await deps.observe(state, cycle);
			cycle.observation = observation;
		} catch (error) {
			cycle.failure = `observation failed: ${error instanceof Error ? error.message : String(error)}`;
			await humanRequired({ reason: cycle.failure, question: "Resolve the repository access problem and retry this autonomous run." }, "controller-error");
			break;
		}
		if (await cancelled()) break;
		if (await checkWallClock()) break;
		await move("ASSESS");

		let decision: AutonomousDecision;
		try {
			decision = await deps.decide(state, cycle, observation);
			cycle.decision = decision;
		} catch (error) {
			if (error instanceof AutonomousHumanRequiredError) {
				cycle.failure = error.message;
				await humanRequired(error.detail);
			} else {
				cycle.failure = `controller decision failed: ${error instanceof Error ? error.message : String(error)}`;
				await humanRequired({ reason: cycle.failure, question: "Inspect the controller artifacts and choose whether to retry or refine the goal." }, "controller-error");
			}
			break;
		}
		if (decision.humanRequired) {
			await humanRequired(decision.humanRequired);
			break;
		}
		if (!state.acceptanceCriteria.length) state.acceptanceCriteria = [...decision.acceptanceCriteria];
		await move("SELECT_OBJECTIVE");
		await move("SELECT_STRATEGY");

		const plan = routeAutonomousDecision(decision, state, deps.stack);
		cycle.plan = plan;
		await move("PLAN");
		if (await cancelled()) break;
		if (await checkWallClock()) break;
		await move("EXECUTE");

		let execution: AutonomousExecutionResult;
		try {
			execution = await deps.execute(state, cycle, decision, plan);
		} catch (error) {
			execution = {
				ok: false,
				strategy: plan.strategy,
				slotIds: plan.slotIds,
				writerSlotId: plan.writerSlotId,
				filesChanged: [],
				summary: "Execution threw before producing a normal result.",
				error: error instanceof Error ? error.message : String(error),
				maxConcurrentWriteEnabledChildren: 0,
				worktreeCommandsObserved: [],
			};
		}
		cycle.execution = execution;
		if (await cancelled()) break;
		if (await checkWallClock()) break;

		let validation: AutonomousValidationResult;
		if (execution.ok) {
			await move("VALIDATE");
			try {
				validation = await deps.validate(state, cycle, observation, execution);
			} catch (error) {
				validation = skippedValidation(`validation harness error: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			validation = skippedValidation(execution.error ?? "execution failed");
		}
		cycle.validation = validation;
		if (await cancelled()) break;
		if (await checkWallClock()) break;
		await move("REVIEW_RESULT");

		let completion: AutonomousCompletionAssessment;
		try {
			completion = await deps.review(state, cycle, observation, decision, plan, execution, validation);
		} catch (error) {
			if (error instanceof AutonomousHumanRequiredError) {
				await humanRequired(error.detail);
				break;
			}
			completion = { done: false, rationale: `completion review failed: ${error instanceof Error ? error.message : String(error)}`, evidence: [] };
		}
		cycle.completion = completion;
		cycle.endedAt = now();
		if (completion.humanRequired) {
			await humanRequired(completion.humanRequired);
			break;
		}

		const objectiveSucceeded = execution.ok && validation.ok;
		if (objectiveSucceeded) {
			state.consecutiveValidationFailures = 0;
			state.retryCounts[decision.objective] = 0;
		} else {
			const retries = (state.retryCounts[decision.objective] ?? 0) + 1;
			state.retryCounts[decision.objective] = retries;
			if (!validation.ok) state.consecutiveValidationFailures++;
			cycle.failure = execution.ok ? `validation failed: ${validation.failures.join("; ")}` : execution.error ?? "execution failed";
			if (retries > state.limits.maxRetriesPerObjective) {
				await humanRequired(
					{
						reason: `Objective retry limit exceeded for: ${decision.objective}`,
						question: "Choose a different approach, clarify the objective, or increase the retry limit?",
						attempted: [decision.objective, cycle.failure],
					},
					"max-retries",
				);
				break;
			}
			if (state.consecutiveValidationFailures >= state.limits.maxConsecutiveValidationFailures) {
				await humanRequired(
					{
						reason: `${state.consecutiveValidationFailures} consecutive validation failures reached the configured safety limit.`,
						question: "Is the goal or acceptance criteria underspecified, or should the controller continue with a higher limit?",
						attempted: [decision.objective, ...validation.failures],
					},
					"validation-failures",
				);
				break;
			}
		}

		if (objectiveSucceeded && completion.done) {
			state = transitionAutonomousState(state, "DONE", now());
			state.stopReason = "goal-satisfied";
			cycle.phase = "DONE";
			await publish();
			break;
		}
		if (mode === "once") {
			await stopped("once-cycle-complete", cycle.failure);
			break;
		}
		if (state.cycle >= state.limits.maxCycles) {
			await humanRequired(
				{
					reason: `Autonomous cycle limit reached (${state.limits.maxCycles}) before the original goal was proven complete.`,
					question: "Increase max cycles, refine the goal, or stop?",
					options: ["Increase max cycles", "Refine the goal", "Stop here"],
				},
				"max-cycles",
			);
			break;
		}
		await move("OBSERVE");
	}
	return state;
}
