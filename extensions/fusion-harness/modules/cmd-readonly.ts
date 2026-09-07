/**
 * cmd-readonly.ts — the strictly read-only N-agent commands.
 *
 * /fh-opinion: every configured slot answers independently.
 * /fh-debate:  N-way all-to-all debate — every round each survivor receives every
 *              other agent's clearly labeled prior opinion; no judge, no hidden merge.
 *
 * Neither command can mutate the checkout: every child runs with READONLY_TOOLS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutonomousCommand } from "./cmd-autonomous.ts";
import { runChild } from "./child-runner.ts";
import { orderedSlots } from "./model-stack.ts";
import { debateClosingPrompt, debateOpeningPrompt, debateRebuttalPrompt, opinionPrompt } from "./prompt-library.ts";
import { clampCount, CUSTOM_TYPE, READONLY_TOOLS, runError, runOk, toStat, type AgentRun, type HarnessDeps } from "./runtime.ts";

const ROUNDS_DEFAULT = 3;

/** Strip an inline `--rounds N` (or `--rounds=N`) from the args, returning it and the remaining prompt. */
function parseRounds(h: HarnessDeps, input: string, fallback = ROUNDS_DEFAULT): { rounds: number; prompt: string } {
	let rounds = clampCount(Number.parseInt(h.flagStr("rounds"), 10), fallback);
	const prompt = input
		.replace(/--rounds[=\s]+(\d+)\s*/g, (_m, n) => {
			rounds = clampCount(Number.parseInt(n, 10), fallback);
			return "";
		})
		.trim();
	return { rounds: Math.min(rounds, 10), prompt };
}

export function registerReadonlyCommands(pi: ExtensionAPI, h: HarnessDeps): void {
	// Autonomous registration lives here to keep the extension factory's command-module
	// seam unchanged; the controller itself is implemented in cmd-autonomous.ts.
	registerAutonomousCommand(pi, h);

	// ── /fh-opinion — N independent read-only opinions ─────
	pi.registerCommand("fh-opinion", {
		description: "Every configured agent answers independently with strict read-only tools; compare all concrete opinions.",
		handler: async (raw, ctx) => {
			h.noteHost(ctx);
			const prompt = (raw ?? "").trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /fh-opinion <prompt>", "warning");
				return;
			}
			const stack = h.modelStack();
			const slots = orderedSlots(stack);
			const runs = slots.map(h.newSlotRun);
			const startedAt = Date.now();
			const artifactsDir = await h.mkArtifacts();
			await h.save(artifactsDir, "prompt.md", prompt);
			await h.save(artifactsDir, "stack.json", JSON.stringify(stack, null, 2));
			h.panel({ kind: "prompt", command: "fh-opinion", ok: true }, `/fh-opinion ${prompt}`);
			const stopper = h.startStoppable(ctx, "fh-opinion");
			const stopWidget = h.startGridWidget(ctx, "fh-opinion", runs, undefined, startedAt);
			ctx.ui.setStatus(CUSTOM_TYPE, `opinion: ${runs.length} agents answering read-only…`);
			try {
				await Promise.all(runs.map(async (run) => {
					const slot = run.slot!;
					const agentDir = path.join(artifactsDir, "agents", slot.id);
					await fs.promises.mkdir(agentDir, { recursive: true });
					await runChild({ run, prompt: opinionPrompt(slot, stack, prompt), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: READONLY_TOOLS, thinking: slot.thinking, ...h.slotInitialSpawn(slot, ctx, agentDir), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
					await h.save(agentDir, "answer.md", runOk(run) ? run.text : `FAILED: ${runError(run)}`);
				}));
				if (stopper.stopped()) {
					h.stoppedPanel("fh-opinion", runs, artifactsDir, startedAt, "All active opinions were stopped; completed answers remain on disk.");
					return;
				}
				const ok = runs.every(runOk);
				h.panel({ kind: "multi", command: "fh-opinion", title: "◆ OPINIONS — ALL CONFIGURED AGENTS", ok, prompt, sources: runs.map(toStat), answers: runs.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot!.id, slotName: run.slot!.name, color: run.slot!.color, primary: run.slot!.primary })), artifactsDir, ...h.totals(runs, startedAt) }, runs.map((run) => `## ${run.slot!.name} · ${run.model}\n${runOk(run) ? run.text : `FAILED: ${runError(run)}`}`).join("\n\n"));
				await h.save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-opinion", ok, agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) }, null, 2));
			} finally {
				await h.ensureSummary(artifactsDir, { command: "fh-opinion", ok: false, stopped: stopper.stopped(), agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) });
				stopper.release();
				stopWidget();
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});

	// ── /fh-debate — N-way concrete opinions, all-to-all between rounds ──
	pi.registerCommand("fh-debate", {
		description: "All configured agents debate read-only. Every round each survivor receives every other agent's clearly labeled prior opinion; no judge.",
		handler: async (raw, ctx) => {
			h.noteHost(ctx);
			const parsed = parseRounds(h, (raw ?? "").trim());
			const rounds = parsed.rounds;
			const prompt = parsed.prompt;
			if (rounds < 2) {
				ctx.ui.notify("fusion-harness: /fh-debate requires at least 2 rounds (opening + closing)", "error");
				return;
			}
			if (!prompt) {
				ctx.ui.notify("Usage: /fh-debate [--rounds N] <prompt>", "warning");
				return;
			}
			const stack = h.modelStack();
			const slots = orderedSlots(stack);
			const runs = slots.map(h.newSlotRun);
			const startedAt = Date.now();
			const artifactsDir = await h.mkArtifacts();
			const initialSpawns = new Map(slots.map((slot) => [slot.id, h.slotInitialSpawn(slot, ctx, path.join(artifactsDir, "debate", slot.id))]));
			await h.save(artifactsDir, "prompt.md", prompt);
			await h.save(artifactsDir, "stack.json", JSON.stringify(stack, null, 2));
			h.panel({ kind: "prompt", command: "fh-debate", ok: true }, `/fh-debate ${(raw ?? "").trim()}`);
			h.panel({ kind: "banner", command: "fh-debate", ok: true, prompt, roles: slots.map((slot) => ({ role: (slot.architect ? "ARCHITECT" : "BUILDER") as AgentRun["role"], model: slot.model, slotId: slot.id, slotName: slot.name, color: slot.color, primary: slot.primary, architect: slot.architect })), maxRounds: rounds, artifactsDir }, "");
			const stopper = h.startStoppable(ctx, "fh-debate");
			const stopWidget = h.startGridWidget(ctx, "fh-debate", runs, undefined, startedAt);
			let previous: AgentRun[] = [];
			try {
				for (let round = 1; round <= rounds; round++) {
					const active = round === 1 ? runs : runs.filter((run) => runOk(run));
					if (active.length < 2) {
						h.panel({ kind: "error", command: "fh-debate", ok: false, round, maxRounds: rounds, sources: runs.map(toStat), artifactsDir, ...h.totals(runs, startedAt) }, `N-way debate halted: fewer than two surviving opinions remain before round ${round}.`);
						return;
					}
					const priorSnapshot = previous.map((run) => ({ ...run, flow: [...run.flow] }));
					let prompts: Map<string, string>;
					try {
						prompts = new Map(active.map((run) => {
							const slot = run.slot!;
							const text = round === 1 ? debateOpeningPrompt(slot, stack, prompt, rounds) : round === rounds ? debateClosingPrompt(slot, prompt, round, rounds, priorSnapshot) : debateRebuttalPrompt(slot, prompt, round, rounds, priorSnapshot);
							return [slot.id, text];
						}));
					} catch (error) {
						h.panel({ kind: "error", command: "fh-debate", ok: false, round, maxRounds: rounds, sources: runs.map(toStat), artifactsDir }, `Debate could not build a complete all-opinions packet: ${error instanceof Error ? error.message : String(error)}. Full prior statements remain in ${artifactsDir}/debate/.`);
						return;
					}
					ctx.ui.setStatus(CUSTOM_TYPE, `debate: round ${round}/${rounds} · ${active.length} concrete opinions…`);
					await Promise.all(active.map(async (run) => {
						const slot = run.slot!;
						const roundDir = path.join(artifactsDir, "debate", `round-${round}`);
						await fs.promises.mkdir(roundDir, { recursive: true });
						const identity = round === 1 ? initialSpawns.get(slot.id)! : h.slotNextSpawn(slot, run, initialSpawns.get(slot.id)!, ctx);
						await runChild({ run, prompt: prompts.get(slot.id)!, systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: READONLY_TOOLS, thinking: slot.thinking, ...identity, cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
						await h.save(roundDir, `${slot.id}.md`, runOk(run) ? run.text : `FAILED: ${runError(run)}`);
					}));
					if (stopper.stopped()) {
						h.stoppedPanel("fh-debate", runs, artifactsDir, startedAt, `Stopped during round ${round}; completed opinions remain on disk.`);
						return;
					}
					if (round < rounds) {
						const missingSessions = runs.filter((run) => runOk(run) && !run.sessionRef);
						if (missingSessions.length) {
							h.panel({ kind: "error", command: "fh-debate", ok: false, round, maxRounds: rounds, sources: runs.map(toStat), artifactsDir }, `Debate cannot preserve round history: no resumable session was reported for ${missingSessions.map((run) => run.slot!.name).join(", ")}.`);
							return;
						}
					}
					previous = runs.map((run) => ({ ...run, flow: [...run.flow] }));
					if (round < rounds) {
						h.panel({ kind: "multi", command: "fh-debate", title: `⚔ ROUND ${round}/${rounds} — ${round === 1 ? "OPENING OPINIONS" : "UPDATED SIDES"}`, ok: runs.filter(runOk).length >= 2, round, maxRounds: rounds, sources: runs.map(toStat), answers: runs.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot!.id, slotName: run.slot!.name, color: run.slot!.color, primary: run.slot!.primary })), artifactsDir }, runs.map((run) => `## [${run.slot!.name.toUpperCase()}]\n${runOk(run) ? run.text : `FAILED: ${runError(run)}`}`).join("\n\n"));
					}
				}

				const survivors = runs.filter(runOk);
				const ok = survivors.length >= 2;
				h.panel({ kind: "closing", command: "fh-debate", ok, round: rounds, maxRounds: rounds, prompt, sources: runs.map(toStat), answers: runs.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot!.id, slotName: run.slot!.name, color: run.slot!.color, primary: run.slot!.primary })), artifactsDir, ...h.totals(runs, startedAt) }, runs.map((run) => `## [${run.slot!.name.toUpperCase()}] FINAL OPINION\n${runOk(run) ? run.text : `FAILED: ${runError(run)}`}`).join("\n\n"));
				await h.save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-debate", ok, rounds, survivors: survivors.map((run) => run.slot!.id), agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) }, null, 2));
			} finally {
				await h.ensureSummary(artifactsDir, { command: "fh-debate", ok: false, stopped: stopper.stopped(), rounds, agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) });
				stopper.release();
				stopWidget();
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});
}
