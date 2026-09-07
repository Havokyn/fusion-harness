import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAutonomousController, AutonomousHumanRequiredError } from "./autonomous-controller.ts";
import {
	parseAutonomousDecision,
	parseCompletionAssessment,
	type AutonomousLimits,
	type AutonomousMode,
	type AutonomousObservation,
	type AutonomousRunState,
} from "./autonomous-state.ts";
import { runChild, runProc } from "./child-runner.ts";
import type { ModelSlot } from "./model-stack.ts";
import { collabProposePrompt, contractSystemPrompt, fill, rosterText } from "./prompt-library.ts";
import {
	CUSTOM_TYPE,
	FULL_TOOLS,
	READONLY_TOOLS,
	runError,
	runOk,
	toStat,
	truncateChars,
	type AgentRun,
	type HarnessDeps,
	type SpawnIdentity,
} from "./runtime.ts";
import { acquireWriterLease, type WriterLease } from "./writer-lease.ts";

const AUTO_WIDGET = `${CUSTOM_TYPE}-autonomous`;
const DECISION_ATTEMPTS = 2;
const VALIDATION_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;

interface ParsedAutonomousArgs {
	mode: AutonomousMode;
	goal: string;
	limits: AutonomousLimits;
}

function boundedInt(value: number, fallback: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export function parseAutonomousArgs(raw: string): ParsedAutonomousArgs {
	let input = raw.trim();
	let maxCyclesRaw: number | undefined;
	let maxRetriesRaw: number | undefined;
	let maxValidationRaw: number | undefined;
	let maxMinutesRaw: number | undefined;
	input = input
		.replace(/--max-cycles[=\s]+(\d+)\s*/g, (_m, n) => { maxCyclesRaw = Number.parseInt(n, 10); return ""; })
		.replace(/--max-retries[=\s]+(\d+)\s*/g, (_m, n) => { maxRetriesRaw = Number.parseInt(n, 10); return ""; })
		.replace(/--max-validation-failures[=\s]+(\d+)\s*/g, (_m, n) => { maxValidationRaw = Number.parseInt(n, 10); return ""; })
		.replace(/--max-minutes[=\s]+(\d+)\s*/g, (_m, n) => { maxMinutesRaw = Number.parseInt(n, 10); return ""; })
		.trim();
	const match = input.match(/^(once|until-done)\s+([\s\S]+)$/);
	if (!match) throw new Error("Usage: /fh-autonomous once <goal>  OR  /fh-autonomous until-done <goal>");
	const mode = match[1] as AutonomousMode;
	const goal = match[2].trim();
	if (!goal) throw new Error("Autonomous goal must not be empty.");
	const defaultCycles = mode === "once" ? 1 : 6;
	return {
		mode,
		goal,
		limits: {
			maxCycles: boundedInt(maxCyclesRaw ?? Number.NaN, defaultCycles, 1, 20),
			maxRetriesPerObjective: boundedInt(maxRetriesRaw ?? Number.NaN, 2, 0, 8),
			maxConsecutiveValidationFailures: boundedInt(maxValidationRaw ?? Number.NaN, 3, 1, 10),
			maxWallClockMs: boundedInt(maxMinutesRaw ?? Number.NaN, 30, 1, 180) * 60_000,
		},
	};
}

function cycleDir(root: string, cycle: number): string {
	return path.join(root, "cycles", String(cycle).padStart(3, "0"));
}

async function writeText(file: string, text: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(file, text, "utf8");
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.promises.rename(tmp, file);
}

function statusFiles(status: string): string[] {
	return status
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const raw = line.length > 3 ? line.slice(3).trim() : line.trim();
			const renamed = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
			return renamed.replace(/^"|"$/g, "");
		})
		.filter(Boolean);
}

function discoverValidationCommands(cwd: string, packageScripts: Record<string, string>): Array<{ command: string; args: string[]; label: string }> {
	const commands: Array<{ command: string; args: string[]; label: string }> = [
		{ command: "git", args: ["diff", "--check"], label: "git diff --check" },
	];
	for (const script of ["test", "typecheck", "lint", "build"]) {
		if (packageScripts[script]) commands.push({ command: "npm", args: ["run", script], label: `npm run ${script}` });
	}
	// If this is not a package repo, `git diff --check` remains a useful deterministic gate.
	void cwd;
	return commands;
}

function readPackageScripts(cwd: string): Record<string, string> {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		if (!parsed?.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return {};
		return Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}

function observationMarkdown(observation: AutonomousObservation): string {
	return [
		`# Observation`,
		``,
		`cwd: ${observation.cwd}`,
		``,
		`## Git status`,
		"```",
		observation.gitStatus || "(clean)",
		"```",
		``,
		`## Validation commands`,
		...observation.validationCommands.map((command) => `- ${command.label}`),
		``,
		`## Package scripts`,
		"```json",
		JSON.stringify(observation.packageScripts, null, 2),
		"```",
		``,
		`## Notes`,
		...(observation.notes.length ? observation.notes.map((note) => `- ${note}`) : ["- none"]),
	].join("\n");
}

function shortStateForPrompt(state: AutonomousRunState): string {
	return JSON.stringify({
		cycle: state.cycle,
		maxCycles: state.limits.maxCycles,
		retryCounts: state.retryCounts,
		consecutiveValidationFailures: state.consecutiveValidationFailures,
		remainingWallClockMs: Math.max(0, state.limits.maxWallClockMs - (Date.now() - state.startedAt)),
	}, null, 2);
}

function renderAutonomousWidget(ctx: any, state: AutonomousRunState): void {
	const current = state.cycles[state.cycles.length - 1];
	const plan = current?.plan;
	const validation = current?.validation;
	const lastResult = current?.completion?.done
		? "overall goal satisfied"
		: current?.failure
			? current.failure
			: current?.execution?.summary ?? "pending";
	const lines = [
		`AUTONOMOUS · ${state.mode}`,
		`Goal: ${state.goal.replace(/\s+/g, " ").slice(0, 120)}${state.goal.length > 120 ? "…" : ""}`,
		`Cycle: ${state.cycle || 1} / ${state.limits.maxCycles}`,
		`Phase: ${state.phase}`,
		`Current objective: ${current?.decision?.objective ?? "observing repository"}`,
		`Strategy: ${plan?.strategy ?? "pending"}`,
		`Agents: ${plan?.slotIds.join(", ") || "pending"}`,
		`Validation: ${validation ? (validation.ok ? "pass" : "fail") : "pending"}`,
		`Last result: ${lastResult.replace(/\s+/g, " ").slice(0, 120)}${lastResult.length > 120 ? "…" : ""}`,
	];
	try { ctx.ui.setWidget(AUTO_WIDGET, lines, { placement: "belowEditor" }); } catch {}
	try { ctx.ui.setStatus(CUSTOM_TYPE, `autonomous: cycle ${state.cycle || 1}/${state.limits.maxCycles} · ${state.phase.toLowerCase()}`); } catch {}
}

function stateSummary(state: AutonomousRunState, artifactsRoot: string): string {
	const current = state.cycles[state.cycles.length - 1];
	const human = state.humanRequired;
	return [
		`## AUTONOMOUS — ${state.phase}`,
		`Goal: ${state.goal}`,
		`Cycles: ${state.cycle}/${state.limits.maxCycles}`,
		`Stop reason: ${state.stopReason ?? "none"}`,
		`Artifacts: ${artifactsRoot}`,
		current?.decision ? `Last objective: ${current.decision.objective}` : "",
		current?.validation ? `Last validation: ${current.validation.ok ? "PASS" : "FAIL"}` : "",
		human ? `\n### Human input required\nBlocked: ${human.reason}\nQuestion: ${human.question}${human.options?.length ? `\nOptions:\n${human.options.map((option) => `- ${option}`).join("\n")}` : ""}` : "",
	].filter(Boolean).join("\n\n");
}

export function registerAutonomousCommand(pi: ExtensionAPI, h: HarnessDeps): void {
	pi.registerCommand("fh-autonomous", {
		description: "Bounded autonomous controller: observe → choose objective/strategy → execute with one writer → validate → reassess the original goal.",
		handler: async (raw, ctx) => {
			h.noteHost(ctx);
			let parsed: ParsedAutonomousArgs;
			try {
				parsed = parseAutonomousArgs((raw ?? "").trim());
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}

			const stack = h.modelStack();
			const artifactsDir = await h.mkArtifacts();
			const autonomousRoot = path.join(artifactsDir, "autonomous");
			await fs.promises.mkdir(path.join(autonomousRoot, "cycles"), { recursive: true });
			await writeText(path.join(autonomousRoot, "goal.md"), `${parsed.goal}\n`);
			await writeJson(path.join(autonomousRoot, "stack.json"), stack);
			h.panel({ kind: "prompt", command: "fh-autonomous", ok: true }, `/fh-autonomous ${(raw ?? "").trim()}`);

			const stopper = h.startStoppable(ctx, "fh-autonomous");
			const slotRuns = new Map<string, { run: AgentRun; initial: SpawnIdentity }>();
			let lastWriterRun: AgentRun | undefined;
			const allRuns: AgentRun[] = [];

			const getSlotRun = async (slot: ModelSlot): Promise<{ run: AgentRun; initial: SpawnIdentity }> => {
				const existing = slotRuns.get(slot.id);
				if (existing) return existing;
				const sessionArtifacts = path.join(autonomousRoot, "sessions", slot.id);
				await fs.promises.mkdir(sessionArtifacts, { recursive: true });
				const value = { run: h.newSlotRun(slot), initial: h.slotInitialSpawn(slot, ctx, sessionArtifacts) };
				slotRuns.set(slot.id, value);
				allRuns.push(value.run);
				return value;
			};

			const runSlot = async (slot: ModelSlot, prompt: string, tools: string, state: AutonomousRunState, systemContract?: string): Promise<AgentRun> => {
				const entry = await getSlotRun(slot);
				const identity = entry.run.status === "pending" ? entry.initial : h.slotNextSpawn(slot, entry.run, entry.initial, ctx);
				const elapsed = Date.now() - state.startedAt;
				const remaining = Math.max(1_000, state.limits.maxWallClockMs - elapsed);
				await runChild({
					run: entry.run,
					prompt,
					systemPrompt: systemContract ? contractSystemPrompt(slot.systemPrompt, systemContract) : slot.systemPrompt,
					appendSystemPrompts: slot.appendSystemPrompts,
					tools,
					thinking: slot.thinking,
					...identity,
					cwd: ctx.cwd,
					timeoutMs: Math.min(h.childTimeoutMs(), remaining),
					signal: stopper.signal,
				});
				return entry.run;
			};

			const runControllerJson = async <T>(
				state: AutonomousRunState,
				cycle: number,
				kind: "decision" | "review",
				prompt: string,
				parse: (text: string) => T,
			): Promise<T> => {
				const slot = stack.architect;
				let nextPrompt = prompt;
				let lastError = "";
				for (let attempt = 1; attempt <= DECISION_ATTEMPTS; attempt++) {
					const run = await runSlot(slot, nextPrompt, READONLY_TOOLS, state, "SYSTEM_PROMPT_AUTONOMOUS.md");
					const dir = cycleDir(autonomousRoot, cycle);
					await writeText(path.join(dir, `controller-${kind}-attempt-${attempt}.md`), runOk(run) ? run.text : `FAILED: ${runError(run)}`);
					if (stopper.signal.aborted) throw new Error("stopped by user");
					if (runOk(run)) {
						try { return parse(run.text); } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
					} else {
						lastError = runError(run);
					}
					nextPrompt = [
						"Your previous autonomous controller output was invalid.",
						`VALIDATION ERROR: ${lastError}`,
						"Return the COMPLETE corrected raw JSON object only. No prose, no markdown fence.",
						"Re-read the repository if needed; do not modify it.",
					].join("\n");
				}
				throw new AutonomousHumanRequiredError({
					reason: `The autonomous ${kind} controller could not produce valid structured JSON after ${DECISION_ATTEMPTS} attempts: ${lastError}`,
					question: "Retry the autonomous run, or refine the goal so the controller can make a determinate choice?",
					attempted: [`${kind} JSON repair attempt 1`, `${kind} JSON repair attempt 2`],
				});
			};

			const readGitStatus = async (state: AutonomousRunState): Promise<string> => {
				const remaining = Math.max(1_000, state.limits.maxWallClockMs - (Date.now() - state.startedAt));
				const result = await runProc("git", ["status", "--short"], ctx.cwd, Math.min(GIT_TIMEOUT_MS, remaining), stopper.signal);
				if (result.code !== 0 && !result.aborted) throw new Error(`git status failed (exit ${result.code}): ${result.output.trim()}`);
				return result.output.trimEnd();
			};

			try {
				const finalState = await runAutonomousController(parsed.goal, parsed.mode, parsed.limits, {
					stack,
					signal: stopper.signal,
					persist: async (state) => {
						await writeJsonAtomic(path.join(autonomousRoot, "run.json"), state);
					},
					onUpdate: (state) => renderAutonomousWidget(ctx, state),
					observe: async (state, cycle) => {
						const gitStatus = await readGitStatus(state);
						const packageScripts = readPackageScripts(ctx.cwd);
						const observation: AutonomousObservation = {
							cwd: ctx.cwd,
							gitStatus,
							changedFiles: statusFiles(gitStatus),
							packageScripts,
							validationCommands: discoverValidationCommands(ctx.cwd, packageScripts),
							notes: [
								fs.existsSync(path.join(ctx.cwd, "tsconfig.json")) ? "TypeScript configuration detected." : "No root tsconfig.json detected.",
								packageScripts.test ? "Repository test script detected and will be used as an evidence gate." : "No package test script detected; validation falls back to available deterministic checks.",
							],
						};
						await writeText(path.join(cycleDir(autonomousRoot, cycle.cycle), "observation.md"), observationMarkdown(observation));
						return observation;
					},
					decide: async (state, cycle, observation) => {
						const decisionPrompt = fill("USER_PROMPT_AUTONOMOUS_DECIDE.md", {
							CYCLE: String(cycle.cycle),
							GOAL: state.goal,
							ACCEPTANCE_CRITERIA: state.acceptanceCriteria.length ? state.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") : "(none fixed yet — derive measurable criteria now)",
							OBSERVATION: truncateChars(JSON.stringify(observation, null, 2), 30_000),
							ROSTER: rosterText(stack),
							LIMITS: shortStateForPrompt(state),
						});
						const decision = await runControllerJson(state, cycle.cycle, "decision", decisionPrompt, parseAutonomousDecision);
						await writeJson(path.join(cycleDir(autonomousRoot, cycle.cycle), "decision.json"), decision);
						await writeText(path.join(cycleDir(autonomousRoot, cycle.cycle), "objective.md"), `${decision.objective}\n`);
						return decision;
					},
					execute: async (state, cycle, decision, plan) => {
						const dir = cycleDir(autonomousRoot, cycle.cycle);
						await writeJson(path.join(dir, "plan.json"), plan);
						const selected = plan.slotIds.map((id) => stack.slots.find((slot) => slot.id === id)).filter((slot): slot is ModelSlot => Boolean(slot));
						const collaboratorReports: Array<{ slot: ModelSlot; run: AgentRun; text: string }> = [];
						if (plan.strategy === "collaborate") {
							await Promise.all(selected.map(async (slot) => {
								const prompt = collabProposePrompt(slot, stack, [
									`AUTONOMOUS OBJECTIVE: ${decision.objective}`,
									`ORIGINAL GOAL: ${state.goal}`,
									`FIXED ACCEPTANCE CRITERIA:\n${state.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
									"Plan only. Do not modify the repository. Identify concrete files, risks, and validation evidence for the sole writer.",
								].join("\n\n"));
								const run = await runSlot(slot, prompt, READONLY_TOOLS, state);
								const text = runOk(run) ? run.text : `FAILED: ${runError(run)}`;
								collaboratorReports.push({ slot, run, text });
								await writeText(path.join(dir, "execution", "planning", `${slot.id}.md`), text);
							}));
							if (stopper.signal.aborted) throw new Error("stopped by user");
							if (collaboratorReports.filter((report) => runOk(report.run)).length < 2) {
								return {
									ok: false,
									strategy: plan.strategy,
									slotIds: plan.slotIds,
									writerSlotId: plan.writerSlotId,
									filesChanged: [],
									summary: "Collaborative planning did not produce two successful read-only plans.",
									error: collaboratorReports.map((report) => `${report.slot.id}: ${runOk(report.run) ? "ok" : runError(report.run)}`).join("; "),
									agents: collaboratorReports.map((report) => { const stat = toStat(report.run); return { slotId: report.slot.id, model: report.slot.model, status: stat.status, tokensIn: stat.tokensIn, tokensOut: stat.tokensOut, costUsd: stat.costUsd }; }),
									maxConcurrentWriteEnabledChildren: 0,
									worktreeCommandsObserved: [],
								};
							}
						}

						const writer = stack.slots.find((slot) => slot.id === plan.writerSlotId) ?? stack.primaryBuilder;
						const plans = collaboratorReports.length
							? collaboratorReports.map((report) => `## ${report.slot.name} (${report.slot.model})\n${truncateChars(report.text, 10_000)}`).join("\n\n")
							: "(single-agent strategy — no collaborator plans requested)";
						const writerPrompt = fill("USER_PROMPT_AUTONOMOUS_EXECUTE.md", {
							GOAL: state.goal,
							OBJECTIVE: decision.objective,
							ACCEPTANCE_CRITERIA: state.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
							RATIONALE: plan.rationale,
							COLLABORATOR_PLANS: plans,
							OBSERVATION: truncateChars(JSON.stringify(cycle.observation ?? {}, null, 2), 20_000),
						});
						let lease: WriterLease | undefined;
						let activeWriters = 0;
						let maxWriters = 0;
						try {
							lease = acquireWriterLease(ctx.cwd, `/fh-autonomous ${path.basename(artifactsDir)} cycle-${cycle.cycle}`);
							activeWriters++;
							maxWriters = Math.max(maxWriters, activeWriters);
							lastWriterRun = await runSlot(writer, writerPrompt, FULL_TOOLS, state, "SYSTEM_PROMPT_AUTONOMOUS_WRITER.md");
						} finally {
							if (activeWriters) activeWriters--;
							lease?.release();
						}
						const writerRun = lastWriterRun!;
						await writeText(path.join(dir, "execution", "writer.md"), runOk(writerRun) ? writerRun.text : `FAILED: ${runError(writerRun)}`);
						const afterStatus = await readGitStatus(state);
						const filesChanged = statusFiles(afterStatus);
						const worktreeCommandsObserved = writerRun.toolEvents.filter((event) => event.name === "bash" && /\bgit\s+worktree\b/.test(event.argument)).map((event) => event.argument);
						const unsafeBackgroundCommands = writerRun.toolEvents.filter((event) => event.name === "bash" && /(?:^|\s)(?:nohup|disown)(?:\s|$)|(?:^|\s)&(?:\s|$)/.test(event.argument)).map((event) => event.argument);
						const stat = toStat(writerRun);
						const ok = runOk(writerRun) && maxWriters === 1 && worktreeCommandsObserved.length === 0 && unsafeBackgroundCommands.length === 0;
						const result = {
							ok,
							strategy: plan.strategy,
							slotIds: plan.slotIds,
							writerSlotId: writer.id,
							filesChanged,
							summary: runOk(writerRun) ? truncateChars(writerRun.text, 12_000) : `Writer failed: ${runError(writerRun)}`,
							error: ok ? undefined : worktreeCommandsObserved.length ? "writer attempted a prohibited git worktree command" : unsafeBackgroundCommands.length ? "writer attempted a prohibited background-process command" : runError(writerRun),
							agents: [
								...collaboratorReports.map((report) => { const s = toStat(report.run); return { slotId: report.slot.id, model: report.slot.model, status: s.status, tokensIn: s.tokensIn, tokensOut: s.tokensOut, costUsd: s.costUsd }; }),
								{ slotId: writer.id, model: writer.model, status: stat.status, tokensIn: stat.tokensIn, tokensOut: stat.tokensOut, costUsd: stat.costUsd },
							],
							maxConcurrentWriteEnabledChildren: maxWriters,
							worktreeCommandsObserved,
						};
						await writeJson(path.join(dir, "execution", "result.json"), { ...result, writerLeasePath: lease?.path, unsafeBackgroundCommands });
						return result;
					},
					validate: async (state, cycle, observation) => {
						const commandResults: Array<{ label: string; code: number; output: string }> = [];
						const failures: string[] = [];
						for (const spec of observation.validationCommands) {
							if (stopper.signal.aborted) break;
							const remaining = Math.max(1_000, state.limits.maxWallClockMs - (Date.now() - state.startedAt));
							const result = await runProc(spec.command, spec.args, ctx.cwd, Math.min(VALIDATION_TIMEOUT_MS, remaining), stopper.signal);
							commandResults.push({ label: spec.label, code: result.code, output: truncateChars(result.output, 20_000) });
							if (result.code !== 0) failures.push(`${spec.label} exited ${result.code}`);
						}
						if (stopper.signal.aborted) failures.push("validation stopped by user");
						const validation = { ok: failures.length === 0 && commandResults.length === observation.validationCommands.length, commands: commandResults, failures };
						const body = commandResults.map((command) => [`## ${command.label} — exit ${command.code}`, "```", command.output.trim() || "(no output)", "```"].join("\n")).join("\n\n");
						await writeText(path.join(cycleDir(autonomousRoot, cycle.cycle), "validation.md"), body || "No validation commands ran.\n");
						return validation;
					},
					review: async (state, cycle, _observation, decision, _plan, execution, validation) => {
						const reviewPrompt = fill("USER_PROMPT_AUTONOMOUS_REVIEW.md", {
							CYCLE: String(cycle.cycle),
							GOAL: state.goal,
							ACCEPTANCE_CRITERIA: state.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
							OBJECTIVE: decision.objective,
							EXECUTION: truncateChars(JSON.stringify(execution, null, 2), 24_000),
							VALIDATION: truncateChars(JSON.stringify(validation, null, 2), 24_000),
						});
						const completion = await runControllerJson(state, cycle.cycle, "review", reviewPrompt, parseCompletionAssessment);
						if (!validation.ok && completion.done) completion.done = false;
						await writeJson(path.join(cycleDir(autonomousRoot, cycle.cycle), "result.json"), completion);
						return completion;
					},
				});

				await h.save(artifactsDir, "summary.json", JSON.stringify({
					command: "fh-autonomous",
					ok: finalState.phase === "DONE",
					mode: finalState.mode,
					goal: finalState.goal,
					phase: finalState.phase,
					cycles: finalState.cycle,
					stopReason: finalState.stopReason,
					humanRequired: finalState.humanRequired,
					autonomousDir: autonomousRoot,
					agents: allRuns.map(toStat),
					sessions: Object.fromEntries(stack.slots.map((slot) => [slot.id, slotRuns.get(slot.id)?.run.sessionRef ?? h.cachedSlotId(slot)])),
					...h.totals(allRuns, finalState.startedAt),
				}, null, 2));
				const body = stateSummary(finalState, autonomousRoot);
				if (finalState.phase === "DONE" && lastWriterRun) h.panel({ kind: "solo", command: "fh-autonomous", ok: true, agent: toStat(lastWriterRun), artifactsDir }, body);
				else h.panel({ kind: "error", command: "fh-autonomous", ok: false, error: finalState.humanRequired?.reason, artifactsDir }, body);
			} finally {
				await h.ensureSummary(artifactsDir, { command: "fh-autonomous", ok: false, stopped: stopper.stopped(), autonomousDir: autonomousRoot, agents: allRuns.map(toStat) });
				h.absorbRuns(allRuns);
				stopper.release();
				try { ctx.ui.setWidget(AUTO_WIDGET, undefined); } catch {}
				try { ctx.ui.setStatus(CUSTOM_TYPE, undefined); } catch {}
			}
		},
	});
}
