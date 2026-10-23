import { describe, expect, test } from "bun:test";
import {
  type ConfigureInput,
  validateCancelInput,
  validateConfigureInput,
  validateInspectInput,
  validateSendInput,
  validateWaitInput,
} from "../src/index.ts";

const rejectedAt = (path: string) => ({ ok: false, error: { code: "INVALID_INPUT", details: { path } } });

describe("configure input", () => {
  const example: ConfigureInput = {
    runId: "run_example",
    expectedRevision: 3,
    patch: { execution: { model: "gpt-6-astra", effort: "high" } },
    apply: "next-turn",
  };

  test("accepts the v2 5.5 example", () => {
    expect(validateConfigureInput(example)).toEqual({ ok: true, value: example });
  });

  test("rejects effort ultra in the patch", () => {
    const input = { ...example, patch: { execution: { effort: "ultra" } } };
    expect(validateConfigureInput(input)).toMatchObject(rejectedAt("$.patch.execution.effort"));
  });

  test("keeps permission changes out of the general patch", () => {
    const input = { ...example, patch: { permissions: { sandbox: "workspace-write" } } };
    expect(validateConfigureInput(input)).toMatchObject(rejectedAt("$.patch.permissions"));
  });

  test("does not offer active-turn application", () => {
    expect(validateConfigureInput({ ...example, apply: "active-turn" })).toMatchObject(rejectedAt("$.apply"));
  });

  test("rejects a revision given as a string", () => {
    expect(validateConfigureInput({ ...example, expectedRevision: "3" })).toMatchObject(
      rejectedAt("$.expectedRevision"),
    );
  });
});

describe("other operation inputs", () => {
  test("inspect takes a runId only", () => {
    expect(validateInspectInput({ runId: "run_a" }).ok).toBe(true);
    expect(validateInspectInput({ runId: "run_a", depth: 2 })).toMatchObject(rejectedAt("$.depth"));
  });

  test("wait needs at least one runId and a mode", () => {
    expect(validateWaitInput({ runIds: ["run_a", "run_b"], mode: "any", timeoutMs: 30000 }).ok).toBe(true);
    expect(validateWaitInput({ runIds: [], mode: "all" })).toMatchObject(rejectedAt("$.runIds"));
    expect(validateWaitInput({ runIds: "run_a", mode: "all" })).toMatchObject(rejectedAt("$.runIds"));
    expect(validateWaitInput({ runIds: ["run_a"], mode: "some" })).toMatchObject(rejectedAt("$.mode"));
  });

  test("send accepts the two delivery policies", () => {
    expect(validateSendInput({ runId: "run_a", text: "Also check tests." }).ok).toBe(true);
    expect(validateSendInput({ runId: "run_a", text: "x", delivery: "active-turn" }).ok).toBe(true);
    expect(validateSendInput({ runId: "run_a", text: "x", delivery: "now" })).toMatchObject(
      rejectedAt("$.delivery"),
    );
  });

  test("send has no caller or connection field for the model to fill", () => {
    expect(validateSendInput({ runId: "run_a", text: "x", caller: "user" })).toMatchObject(rejectedAt("$.caller"));
  });

  test("cancel needs a reason", () => {
    expect(validateCancelInput({ runId: "run_a", reason: "no longer needed" }).ok).toBe(true);
    expect(validateCancelInput({ runId: "run_a" })).toMatchObject(rejectedAt("$.reason"));
  });
});
