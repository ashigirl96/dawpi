import { describe, expect, test } from "bun:test";
import {
  type BridgeEvent,
  type RunResult,
  delegateInputSchema,
  toJsonSchema,
  validateBridgeEvent,
  validateRunResult,
} from "../src/index.ts";

const rejectedAt = (path: string) => ({ ok: false, error: { code: "INVALID_INPUT", details: { path } } });

describe("RunResult", () => {
  const result: RunResult = {
    resultId: "res_1",
    runId: "run_a",
    outcome: "incomplete",
    summary: "Child run_b failed; review covers only the API layer.",
    artifacts: [{ path: "src/auth.ts", contentHash: "sha256:abc", range: { startLine: 10, endLine: 42 } }],
    checks: [{ name: "bun test", status: "passed", verified: false }],
    childResults: [{ runId: "run_b", resultId: "res_2", outcome: "failed" }],
    hasUnresolvedIssues: true,
  };

  test("accepts a result that keeps a failed child", () => {
    expect(validateRunResult(result)).toEqual({ ok: true, value: result });
  });

  test("rejects a child outcome outside the four outcomes", () => {
    const input = { ...result, childResults: [{ runId: "run_b", resultId: "res_2", outcome: "done" }] };
    expect(validateRunResult(input)).toMatchObject(rejectedAt("$.childResults[0].outcome"));
  });
});

describe("BridgeEvent", () => {
  const event: BridgeEvent = {
    schemaVersion: 1,
    runId: "run_a",
    seq: 7,
    observedAt: "2026-10-24T00:00:00.000Z",
    origin: "codex",
    kind: "item/started",
    providerRef: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    payload: { anything: ["goes", 1] },
  };

  test("accepts an event with an opaque payload", () => {
    expect(validateBridgeEvent(event)).toEqual({ ok: true, value: event });
  });

  test("rejects another schema version", () => {
    expect(validateBridgeEvent({ ...event, schemaVersion: 2 })).toMatchObject(rejectedAt("$.schemaVersion"));
  });
});

describe("published inputSchema", () => {
  test("closes every object of the delegate input", () => {
    const openObjects: string[] = [];
    const walk = (node: Record<string, unknown>, path: string) => {
      if (node.type === "object" && node.properties) {
        if (node.additionalProperties !== false) openObjects.push(path);
        for (const [key, child] of Object.entries(node.properties as Record<string, Record<string, unknown>>))
          walk(child, `${path}.${key}`);
      }
      if (node.items) walk(node.items as Record<string, unknown>, `${path}[]`);
    };
    const schema = toJsonSchema(delegateInputSchema);
    walk(schema, "$");
    expect(schema).toMatchObject({ type: "object", required: ["task"] });
    expect(openObjects).toEqual([]);
  });
});
