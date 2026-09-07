import { describe, expect, test } from "bun:test";
import { runAutonomousController, type AutonomousControllerDeps } from "../modules/autonomous-controller.ts";
import type { AutonomousDecision, AutonomousRunState } from "../modules/autonomous-state.ts";
import type { ModelStack } from "../modules/model-stack.ts";

const stack: ModelStack = {
  codename: "test",
  slots: [
    { id: "arch", name: "arch", model: "provider/architect", thinking: "medium", color: "#A78BFA", architect: true, primary: false, appendSystemPrompts: [] },
    { id: "main", name: "main", model: "provider/main", thinking: "medium", color: "#F59E0B", architect: false, primary: true, appendSystemPrompts: [] },
    { id: "review", name: "review", model: "provider/review", thinking: "medium", color: "#34D399", architect: false, primary: false, appendSystemPrompts: [] },
  ],
  architect: undefined as never,
  primaryBuilder: undefined as never,
  builders: [],
};
stack.architect = stack.slots[0];
stack.primaryBuilder = stack.slots[1];
stack.builders = stack.slots.slice(1);

const limits = (overrides: Partial<AutonomousRunState["limits"]> = {}) => ({
  maxCycles: 4,
  maxRetriesPerObjective: 2,
  maxConsecutiveValidationFailures: 3,
  maxWallClockMs: 1_000_000,
  ...overrides,
});

const baseDecision: AutonomousDecision = {
  objective: "fix deterministic behavior",
  rationale: "small localized objective",
  acceptanceCriteria: ["test suite passes"],
  strategy: "single",
  slotIds: ["main"],
};

function deps(overrides: Partial<AutonomousControllerDeps> = {}) {
  const persisted: AutonomousRunState[] = [];
  const strategies: string[] = [];
  let tick = 100;
  const value: AutonomousControllerDeps & { persisted: AutonomousRunState[]; strategies: string[] } = {
    stack,
    now: () => tick++,
    observe: async () => ({ cwd: "/repo", gitStatus: "", changedFiles: [], packageScripts: { test: "bun test" }, validationCommands: [{ command: "bun", args: ["test"], label: "bun test" }], notes: [] }),
    decide: async () => ({ ...baseDecision }),
    execute: async (_state, _cycle, _decision, plan) => {
      strategies.push(plan.strategy);
      return { ok: true, strategy: plan.strategy, slotIds: plan.slotIds, writerSlotId: plan.writerSlotId, filesChanged: ["x.ts"], summary: "implemented", maxConcurrentWriteEnabledChildren: 1, worktreeCommandsObserved: [] };
    },
    validate: async () => ({ ok: true, commands: [{ label: "bun test", code: 0, output: "pass" }], failures: [] }),
    review: async () => ({ done: true, rationale: "criteria proven", evidence: ["tests pass"] }),
    persist: async (state) => { persisted.push(structuredClone(state)); },
    ...overrides,
    persisted,
    strategies,
  };
  return value;
}

describe("autonomous controller", () => {
  test("completes successfully only after validation and overall review", async () => {
    const d = deps();
    const state = await runAutonomousController("goal", "until-done", limits(), d);
    expect(state.phase).toBe("DONE");
    expect(state.stopReason).toBe("goal-satisfied");
    expect(state.cycle).toBe(1);
    expect(state.cycles[0].validation?.ok).toBe(true);
    expect(state.cycles[0].completion?.done).toBe(true);
    expect(d.persisted.length).toBeGreaterThan(6);
  });

  test("validation failure retries and escalates single -> collaborate", async () => {
    let validationCall = 0;
    let reviewCall = 0;
    const d = deps({
      validate: async () => ++validationCall === 1
        ? { ok: false, commands: [{ label: "bun test", code: 1, output: "fail" }], failures: ["bun test exited 1"] }
        : { ok: true, commands: [{ label: "bun test", code: 0, output: "pass" }], failures: [] },
      review: async () => ({ done: ++reviewCall >= 2, rationale: "reviewed", evidence: [] }),
    });
    const state = await runAutonomousController("goal", "until-done", limits(), d);
    expect(state.phase).toBe("DONE");
    expect(state.cycle).toBe(2);
    expect(d.strategies).toEqual(["single", "collaborate"]);
  });

  test("validation failure safety limit transitions to HUMAN_REQUIRED", async () => {
    const d = deps({
      validate: async () => ({ ok: false, commands: [{ label: "test", code: 1, output: "fail" }], failures: ["test exited 1"] }),
      review: async () => ({ done: false, rationale: "still failing", evidence: [] }),
    });
    const state = await runAutonomousController("goal", "until-done", limits({ maxConsecutiveValidationFailures: 1, maxRetriesPerObjective: 5 }), d);
    expect(state.phase).toBe("HUMAN_REQUIRED");
    expect(state.stopReason).toBe("validation-failures");
  });

  test("max retry stop is bounded", async () => {
    const d = deps({
      execute: async (_state, _cycle, _decision, plan) => ({ ok: false, strategy: plan.strategy, slotIds: plan.slotIds, writerSlotId: plan.writerSlotId, filesChanged: [], summary: "failed", error: "writer failed", maxConcurrentWriteEnabledChildren: 0, worktreeCommandsObserved: [] }),
      review: async () => ({ done: false, rationale: "failed", evidence: [] }),
    });
    const state = await runAutonomousController("goal", "until-done", limits({ maxRetriesPerObjective: 0, maxConsecutiveValidationFailures: 5 }), d);
    expect(state.phase).toBe("HUMAN_REQUIRED");
    expect(state.stopReason).toBe("max-retries");
  });

  test("max cycle stop does not claim the goal is done", async () => {
    const d = deps({ review: async () => ({ done: false, rationale: "more remains", evidence: [] }) });
    const state = await runAutonomousController("goal", "until-done", limits({ maxCycles: 1 }), d);
    expect(state.phase).toBe("HUMAN_REQUIRED");
    expect(state.stopReason).toBe("max-cycles");
  });

  test("once mode performs one objective cycle then stops when overall goal remains", async () => {
    const d = deps({ review: async () => ({ done: false, rationale: "more remains", evidence: [] }) });
    const state = await runAutonomousController("goal", "once", limits({ maxCycles: 1 }), d);
    expect(state.phase).toBe("STOPPED");
    expect(state.stopReason).toBe("once-cycle-complete");
    expect(state.cycle).toBe(1);
  });

  test("controller honors structured HUMAN_REQUIRED before execution", async () => {
    let executions = 0;
    const d = deps({
      decide: async () => ({ ...baseDecision, humanRequired: { reason: "missing credential", question: "Provide credential?" } }),
      execute: async (_state, _cycle, _decision, plan) => { executions++; return { ok: true, strategy: plan.strategy, slotIds: plan.slotIds, writerSlotId: plan.writerSlotId, filesChanged: [], summary: "should not run", maxConcurrentWriteEnabledChildren: 1, worktreeCommandsObserved: [] }; },
    });
    const state = await runAutonomousController("goal", "until-done", limits(), d);
    expect(state.phase).toBe("HUMAN_REQUIRED");
    expect(state.humanRequired?.reason).toBe("missing credential");
    expect(executions).toBe(0);
  });

  test("cancellation stops before a child objective cycle starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps({ signal: controller.signal });
    const state = await runAutonomousController("goal", "until-done", limits(), d);
    expect(state.phase).toBe("STOPPED");
    expect(state.stopReason).toBe("cancelled");
    expect(state.cycle).toBe(0);
  });
});
