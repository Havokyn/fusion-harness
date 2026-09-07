import { describe, expect, test } from "bun:test";
import type { ModelStack } from "../modules/model-stack.ts";
import {
  createAutonomousState,
  parseAutonomousDecision,
  parseCompletionAssessment,
  routeAutonomousDecision,
  transitionAutonomousState,
} from "../modules/autonomous-state.ts";

const stack: ModelStack = {
  codename: "test",
  slots: [
    { id: "arch", name: "arch", model: "provider/architect", thinking: "medium", color: "#A78BFA", architect: true, primary: false, appendSystemPrompts: [] },
    { id: "main", name: "main", model: "provider/main", thinking: "medium", color: "#F59E0B", architect: false, primary: true, appendSystemPrompts: [] },
    { id: "review", name: "review", model: "provider/review", thinking: "medium", color: "#34D399", architect: false, primary: false, appendSystemPrompts: [] },
    { id: "extra", name: "extra", model: "provider/extra", thinking: "medium", color: "#22D3EE", architect: false, primary: false, appendSystemPrompts: [] },
  ],
  architect: undefined as never,
  primaryBuilder: undefined as never,
  builders: [],
};
stack.architect = stack.slots[0];
stack.primaryBuilder = stack.slots[1];
stack.builders = stack.slots.slice(1);

const limits = { maxCycles: 6, maxRetriesPerObjective: 2, maxConsecutiveValidationFailures: 3, maxWallClockMs: 60_000 };
const decision = {
  objective: "implement the small fix",
  rationale: "localized change",
  acceptanceCriteria: ["tests pass"],
  strategy: "single" as const,
  slotIds: ["review"],
};

describe("autonomous state", () => {
  test("enforces state transitions", () => {
    let state = createAutonomousState("goal", "until-done", limits, 1);
    state = transitionAutonomousState(state, "ASSESS", 2);
    expect(state.phase).toBe("ASSESS");
    expect(() => transitionAutonomousState(state, "EXECUTE", 3)).toThrow("invalid autonomous state transition");
  });

  test("parses strict decision JSON and rejects malformed output", () => {
    const parsed = parseAutonomousDecision(JSON.stringify({ ...decision, humanRequired: null }));
    expect(parsed.objective).toBe(decision.objective);
    expect(() => parseAutonomousDecision("```json\n{}\n```")).toThrow("raw JSON object");
    expect(() => parseAutonomousDecision('{"objective":"x"')).toThrow("raw JSON object");
    expect(() => parseAutonomousDecision('{"objective":"x","rationale":"r","acceptanceCriteria":[],"strategy":"magic","slotIds":[]}')).toThrow("acceptanceCriteria");
  });

  test("parses completion and structured HUMAN_REQUIRED", () => {
    const parsed = parseCompletionAssessment(JSON.stringify({ done: false, rationale: "credential needed", evidence: [], humanRequired: { reason: "missing credential", question: "Provide access?", options: ["yes", "no"] } }));
    expect(parsed.humanRequired?.reason).toBe("missing credential");
  });

  test("single-agent routing honors a requested builder subset", () => {
    const state = createAutonomousState("goal", "until-done", limits, 1);
    const plan = routeAutonomousDecision(decision, state, stack);
    expect(plan.strategy).toBe("single");
    expect(plan.slotIds).toEqual(["review"]);
    expect(plan.writerSlotId).toBe("review");
  });

  test("failure evidence escalates single-agent work to a collaborative subset", () => {
    const state = createAutonomousState("goal", "until-done", limits, 1);
    state.retryCounts[decision.objective] = 1;
    const plan = routeAutonomousDecision(decision, state, stack);
    expect(plan.strategy).toBe("collaborate");
    expect(plan.escalated).toBe(true);
    expect(plan.slotIds).toEqual(["arch", "main", "review"]);
    expect(plan.writerSlotId).toBe("main");
  });

  test("repeated failures escalate to the whole configured stack", () => {
    const state = createAutonomousState("goal", "until-done", limits, 1);
    state.consecutiveValidationFailures = 2;
    const plan = routeAutonomousDecision(decision, state, stack);
    expect(plan.strategy).toBe("collaborate");
    expect(plan.slotIds).toEqual(["arch", "main", "review", "extra"]);
  });
});
