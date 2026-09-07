import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const command = readFileSync(join(root, "modules", "cmd-autonomous.ts"), "utf8");
const controller = readFileSync(join(root, "modules", "autonomous-controller.ts"), "utf8");
const state = readFileSync(join(root, "modules", "autonomous-state.ts"), "utf8");
const writerPrompt = readFileSync(join(root, "prompts", "SYSTEM_PROMPT_AUTONOMOUS_WRITER.md"), "utf8");
const controllerPrompt = readFileSync(join(root, "prompts", "SYSTEM_PROMPT_AUTONOMOUS.md"), "utf8");

describe("autonomous orchestration contracts", () => {
  test("registers both autonomous modes and persists structured run artifacts", () => {
    expect(command).toContain('registerCommand("fh-autonomous"');
    expect(command).toContain('"once" | "until-done"');
    expect(command).toContain('path.join(autonomousRoot, "run.json")');
    expect(command).toContain('path.join(autonomousRoot, "goal.md")');
    expect(command).toContain('"observation.md"');
    expect(command).toContain('"decision.json"');
    expect(command).toContain('"plan.json"');
    expect(command).toContain('"validation.md"');
    expect(command).toContain('"result.json"');
  });

  test("structured controller output gets one bounded repair attempt", () => {
    expect(command).toContain("const DECISION_ATTEMPTS = 2");
    expect(command).toContain("for (let attempt = 1; attempt <= DECISION_ATTEMPTS; attempt++)");
    expect(command).toContain("Your previous autonomous controller output was invalid.");
    expect(command).toContain("Return the COMPLETE corrected raw JSON object only");
    expect(state).toContain("must be one raw JSON object with no prose or code fence");
  });

  test("autonomous writes use the existing CWD lease and exactly one full-tool writer path", () => {
    expect(command).toContain("acquireWriterLease(ctx.cwd, `/fh-autonomous");
    expect(command).toContain("activeWriters++");
    expect(command).toContain("maxConcurrentWriteEnabledChildren: maxWriters");
    const fullToolWriterCalls = command.match(/runSlot\(writer, writerPrompt, FULL_TOOLS/g) ?? [];
    expect(fullToolWriterCalls).toHaveLength(1);
    expect(command).toContain("worktreeCommandsObserved");
    expect(writerPrompt).toContain("Never create a worktree");
    expect(writerPrompt).toContain("Never use `&`, `nohup`, `disown`");
  });

  test("planning and controller reasoning stay read-only and preserve slot session routing", () => {
    expect(command).toContain("runSlot(slot, prompt, READONLY_TOOLS");
    expect(command).toContain("runSlot(slot, nextPrompt, READONLY_TOOLS");
    expect(command).toContain("h.slotInitialSpawn(slot, ctx");
    expect(command).toContain("h.slotNextSpawn(slot, entry.run, entry.initial, ctx)");
    expect(controllerPrompt).toContain("read-only decision/review controller");
  });

  test("hard limits and HUMAN_REQUIRED are first-class state-machine outcomes", () => {
    for (const phase of ["OBSERVE", "ASSESS", "SELECT_OBJECTIVE", "SELECT_STRATEGY", "PLAN", "EXECUTE", "VALIDATE", "REVIEW_RESULT", "DONE", "HUMAN_REQUIRED"]) {
      expect(state).toContain(`"${phase}"`);
    }
    expect(controller).toContain('"max-cycles"');
    expect(controller).toContain('"max-retries"');
    expect(controller).toContain('"validation-failures"');
    expect(controller).toContain('"wall-clock-limit"');
    expect(controller).toContain('"cancelled"');
  });

  test("routing is slot-based, not provider-name based", () => {
    expect(state).toContain("stack.primaryBuilder.id");
    expect(state).toContain("stack.architect.id");
    expect(state).not.toContain("openai/");
    expect(state).not.toContain("anthropic/");
    expect(state).not.toContain("google/");
  });
});
