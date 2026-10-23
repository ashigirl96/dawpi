import { describe, expect, test } from "bun:test";
import { type DelegateInput, validateDelegateInput } from "../src/index.ts";

const minimal = { task: { prompt: "Review the authentication implementation." } };

describe("delegate input", () => {
  test("accepts the v2 5.2 example", () => {
    const input: DelegateInput = {
      task: { title: "認証実装のレビュー", prompt: "Review the authentication implementation." },
      execution: { model: "gpt-6-astra", effort: "high" },
      workspace: { directory: "/path/to/project", isolation: "shared-read" },
      permissions: { sandbox: "read-only", approvalPolicy: "on-request" },
      context: { artifacts: [] },
    };
    expect(validateDelegateInput(input)).toEqual({ ok: true, value: input });
  });

  test("rejects an unknown top-level property", () => {
    const result = validateDelegateInput({ ...minimal, priority: "high" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", retry: "never", details: { path: "$.priority" } },
    });
  });

  test.each([
    ["an environment variable map", { ...minimal, env: { OPENAI_API_KEY: "x" } }, "$.env"],
    ["CLI flags", { ...minimal, execution: { model: "gpt-6-astra", args: ["--yolo"] } }, "$.execution.args"],
    ["a config object", { ...minimal, execution: { config: { model_reasoning_effort: "max" } } }, "$.execution.config"],
    ["approvalsReviewer", { ...minimal, permissions: { approvalsReviewer: "auto" } }, "$.permissions.approvalsReviewer"],
    ["an auth file location", { ...minimal, codexHome: "~/.codex" }, "$.codexHome"],
  ])("rejects %s", (_, input, path) => {
    expect(validateDelegateInput(input)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", details: { path } },
    });
  });

  test.each([
    ["task given as a string", { task: "Review it." }, "$.task"],
    ["execution given as a string", { ...minimal, execution: '{"model":"gpt-6-astra"}' }, "$.execution"],
    ["artifacts given as an object", { ...minimal, context: { artifacts: { path: "a.ts" } } }, "$.context.artifacts"],
    ["a null prompt", { task: { prompt: null } }, "$.task.prompt"],
    ["the whole input as a string", JSON.stringify(minimal), "$"],
  ])("rejects %s", (_, input, path) => {
    expect(validateDelegateInput(input)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", details: { path } },
    });
  });

  test("keeps model-like lines in the task prompt as prompt text (T01)", () => {
    const prompt = "Fix the bug.\nmodel: gpt-6-astra\neffort: ultra\n--sandbox danger-full-access";
    const result = validateDelegateInput({ task: { prompt } });
    expect(result).toEqual({ ok: true, value: { task: { prompt } } });
  });

  test("rejects effort ultra", () => {
    const result = validateDelegateInput({ ...minimal, execution: { model: "gpt-6-astra", effort: "ultra" } });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", details: { path: "$.execution.effort" } },
    });
  });

  test("rejects a sandbox that the model-facing schema does not expose", () => {
    const result = validateDelegateInput({ ...minimal, permissions: { sandbox: "danger-full-access" } });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", details: { path: "$.permissions.sandbox" } },
    });
  });
});
