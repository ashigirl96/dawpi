import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, firstLine, shortSocketPath, start, tempHome } from "./harness.ts";

afterEach(cleanupAll);

describe("Worker Roster and Permit commands", () => {
  test("refuses a Permit for an agent not on the Worker Roster", async () => {
    const s = await start();
    const { json } = await s.command({ op: "permit.issue", agentId: "agent-x", tool: "Bash" });
    expect(json).toMatchObject({ ok: false, error: { code: "STATE_CONFLICT" } });
  });

  test("issues a distinct tool_use_id for every Permit", async () => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const a = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "Bash" });
    const b = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "Bash" });
    expect(a.json.value.toolUseId).toMatch(/^toolu_[A-Za-z0-9_]+$/);
    expect(a.json.value.toolUseId).not.toBe(b.json.value.toolUseId);
  });

  test.each(["../escape", "a/b", "", 42])("refuses agentId %p", async agentId => {
    const s = await start();
    const { json } = await s.command({ op: "roster.add", agentId });
    expect(json).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { path: "agentId" } } });
  });

  test("refuses to start with an unknown --handback-decision", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        `${import.meta.dir}/../src/main.ts`,
        "--session",
        "sess-x",
        "--socket",
        shortSocketPath(),
        "--home",
        tempHome(),
        "--handback-decision",
        "maybe",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const line = JSON.parse(await firstLine(proc.stdout));
    expect(line).toMatchObject({ kind: "error" });
    expect(await proc.exited).toBe(1);
  });
});
