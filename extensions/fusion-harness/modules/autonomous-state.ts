import type { ModelStack } from "./model-stack.ts";

export type AutonomousMode = "once" | "until-done";
export type AutonomousStrategy = "single" | "collaborate";
export type AutonomousPhase =
	| "OBSERVE"
	| "ASSESS"
	| "SELECT_OBJECTIVE"
	| "SELECT_STRATEGY"
	| "PLAN"
	| "EXECUTE"
	| "VALIDATE"
	| "REVIEW_RESULT"
	| "DONE"
	| "HUMAN_REQUIRED"
	| "STOPPED";

export type AutonomousStopReason =
	| "goal-satisfied"
	| "once-cycle-complete"
	| "cancelled"
	| "max-cycles"
	| "max-retries"
	| "validation-failures"
	| "wall-clock-limit"
	| "human-required"
	| "controller-error";

export interface AutonomousLimits {
	maxCycles: number;
	maxRetriesPerObjective: number;
	maxConsecutiveValidationFailures: number;
	maxWallClockMs: number;
}

export interface AutonomousObservation {
	cwd: string;
	gitStatus: string;
	changedFiles: string[];
	packageScripts: Record<string, string>;
	validationCommands: Array<{ command: string; args: string[]; label: string }>;
	notes: string[];
}

export interface HumanRequiredDetail {
	reason: string;
	question: string;
	options?: string[];
	attempted?: string[];
}

export interface AutonomousDecision {
	objective: string;
	rationale: string;
	acceptanceCriteria: string[];
	strategy: AutonomousStrategy;
	slotIds: string[];
	humanRequired?: HumanRequiredDetail;
}

export interface AutonomousPlan {
	strategy: AutonomousStrategy;
	slotIds: string[];
	writerSlotId: string;
	rationale: string;
	escalated: boolean;
}

export interface AutonomousExecutionResult {
	ok: boolean;
	strategy: AutonomousStrategy;
	slotIds: string[];
	writerSlotId: string;
	filesChanged: string[];
	summary: string;
	error?: string;
	agents?: Array<{
		slotId: string;
		model: string;
		status: string;
		tokensIn?: number;
		tokensOut?: number;
		costUsd?: number;
	}>;
	maxConcurrentWriteEnabledChildren: number;
	worktreeCommandsObserved: string[];
}

export interface AutonomousValidationResult {
	ok: boolean;
	commands: Array<{
		label: string;
		code: number;
		output: string;
	}>;
	failures: string[];
}

export interface AutonomousCompletionAssessment {
	done: boolean;
	rationale: string;
	evidence: string[];
	humanRequired?: HumanRequiredDetail;
}

export interface AutonomousCycleRecord {
	cycle: number;
	phase: AutonomousPhase;
	observation?: AutonomousObservation;
	decision?: AutonomousDecision;
	plan?: AutonomousPlan;
	execution?: AutonomousExecutionResult;
	validation?: AutonomousValidationResult;
	completion?: AutonomousCompletionAssessment;
	failure?: string;
	startedAt: number;
	endedAt?: number;
}

export interface AutonomousRunState {
	version: 1;
	goal: string;
	mode: AutonomousMode;
	phase: AutonomousPhase;
	cycle: number;
	limits: AutonomousLimits;
	startedAt: number;
	updatedAt: number;
	acceptanceCriteria: string[];
	cycles: AutonomousCycleRecord[];
	retryCounts: Record<string, number>;
	consecutiveValidationFailures: number;
	stopReason?: AutonomousStopReason;
	humanRequired?: HumanRequiredDetail;
}

const TERMINAL_PHASES = new Set<AutonomousPhase>(["DONE", "HUMAN_REQUIRED", "STOPPED"]);
const ALLOWED_TRANSITIONS: Record<AutonomousPhase, AutonomousPhase[]> = {
	OBSERVE: ["ASSESS", "HUMAN_REQUIRED", "STOPPED"],
	ASSESS: ["SELECT_OBJECTIVE", "HUMAN_REQUIRED", "STOPPED"],
	SELECT_OBJECTIVE: ["SELECT_STRATEGY", "HUMAN_REQUIRED", "STOPPED"],
	SELECT_STRATEGY: ["PLAN", "HUMAN_REQUIRED", "STOPPED"],
	PLAN: ["EXECUTE", "HUMAN_REQUIRED", "STOPPED"],
	EXECUTE: ["VALIDATE", "REVIEW_RESULT", "HUMAN_REQUIRED", "STOPPED"],
	VALIDATE: ["REVIEW_RESULT", "HUMAN_REQUIRED", "STOPPED"],
	REVIEW_RESULT: ["OBSERVE", "DONE", "HUMAN_REQUIRED", "STOPPED"],
	DONE: [],
	HUMAN_REQUIRED: [],
	STOPPED: [],
};

export const isTerminalPhase = (phase: AutonomousPhase): boolean => TERMINAL_PHASES.has(phase);

export function createAutonomousState(goal: string, mode: AutonomousMode, limits: AutonomousLimits, now = Date.now()): AutonomousRunState {
	return {
		version: 1,
		goal,
		mode,
		phase: "OBSERVE",
		cycle: 0,
		limits,
		startedAt: now,
		updatedAt: now,
		acceptanceCriteria: [],
		cycles: [],
		retryCounts: {},
		consecutiveValidationFailures: 0,
	};
}

export function transitionAutonomousState(state: AutonomousRunState, next: AutonomousPhase, now = Date.now()): AutonomousRunState {
	if (state.phase === next) return { ...state, updatedAt: now };
	if (!ALLOWED_TRANSITIONS[state.phase].includes(next)) {
		throw new Error(`invalid autonomous state transition ${state.phase} -> ${next}`);
	}
	return { ...state, phase: next, updatedAt: now };
}

function rawObject(text: string, label: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error(`${label} must be one raw JSON object with no prose or code fence`);
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch (error) {
		throw new Error(`${label} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
	return parsed as Record<string, unknown>;
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must be an array of non-empty strings`);
	const result = value.map((item) => (item as string).trim());
	if (!allowEmpty && result.length === 0) throw new Error(`${field} must not be empty`);
	return result;
}

function parseHumanRequired(value: unknown): HumanRequiredDetail | undefined {
	if (value === undefined || value === null || value === false) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("humanRequired must be null/false or an object");
	const record = value as Record<string, unknown>;
	const reason = typeof record.reason === "string" ? record.reason.trim() : "";
	const question = typeof record.question === "string" ? record.question.trim() : "";
	if (!reason || !question) throw new Error("humanRequired.reason and humanRequired.question must be non-empty strings");
	const options = record.options === undefined ? undefined : stringArray(record.options, "humanRequired.options", true);
	const attempted = record.attempted === undefined ? undefined : stringArray(record.attempted, "humanRequired.attempted", true);
	return { reason, question, options, attempted };
}

export function parseAutonomousDecision(text: string): AutonomousDecision {
	const parsed = rawObject(text, "autonomy decision");
	const objective = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
	const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
	if (!objective) throw new Error("autonomy decision.objective must be a non-empty string");
	if (!rationale) throw new Error("autonomy decision.rationale must be a non-empty string");
	const acceptanceCriteria = stringArray(parsed.acceptanceCriteria, "autonomy decision.acceptanceCriteria");
	if (parsed.strategy !== "single" && parsed.strategy !== "collaborate") throw new Error("autonomy decision.strategy must be single or collaborate");
	const slotIds = stringArray(parsed.slotIds ?? [], "autonomy decision.slotIds", true);
	return {
		objective,
		rationale,
		acceptanceCriteria,
		strategy: parsed.strategy,
		slotIds,
		humanRequired: parseHumanRequired(parsed.humanRequired),
	};
}

export function parseCompletionAssessment(text: string): AutonomousCompletionAssessment {
	const parsed = rawObject(text, "completion assessment");
	if (typeof parsed.done !== "boolean") throw new Error("completion assessment.done must be boolean");
	const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
	if (!rationale) throw new Error("completion assessment.rationale must be a non-empty string");
	return {
		done: parsed.done,
		rationale,
		evidence: stringArray(parsed.evidence ?? [], "completion assessment.evidence", true),
		humanRequired: parseHumanRequired(parsed.humanRequired),
	};
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function routeAutonomousDecision(decision: AutonomousDecision, state: AutonomousRunState, stack: ModelStack): AutonomousPlan {
	const known = new Set(stack.slots.map((slot) => slot.id));
	const requested = unique(decision.slotIds.filter((id) => known.has(id)));
	const failuresForObjective = state.retryCounts[decision.objective] ?? 0;
	const forceCollaborate = failuresForObjective > 0 || state.consecutiveValidationFailures > 0;
	const strategy: AutonomousStrategy = forceCollaborate ? "collaborate" : decision.strategy;
	let slotIds: string[];
	if (strategy === "single") {
		const requestedBuilder = requested.find((id) => stack.builders.some((slot) => slot.id === id));
		slotIds = [requestedBuilder ?? stack.primaryBuilder.id];
	} else if (failuresForObjective >= 2 || state.consecutiveValidationFailures >= 2) {
		slotIds = stack.slots.map((slot) => slot.id);
	} else if (requested.length >= 2) {
		slotIds = unique([stack.architect.id, stack.primaryBuilder.id, ...requested]);
	} else {
		const extra = stack.builders.find((slot) => slot.id !== stack.primaryBuilder.id);
		slotIds = unique([stack.architect.id, stack.primaryBuilder.id, ...(extra ? [extra.id] : [])]);
	}
	return {
		strategy,
		slotIds,
		writerSlotId: strategy === "single" ? slotIds[0] : stack.primaryBuilder.id,
		rationale: forceCollaborate ? `${decision.rationale} Escalated to collaborative execution after prior failure evidence.` : decision.rationale,
		escalated: forceCollaborate && decision.strategy !== "collaborate",
	};
}

export function wallClockExceeded(state: AutonomousRunState, now = Date.now()): boolean {
	return now - state.startedAt >= state.limits.maxWallClockMs;
}
