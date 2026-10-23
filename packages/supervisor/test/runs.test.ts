import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCommands } from "../src/commands.ts";
import { EventLog } from "../src/control/event-log.ts";
import { createGuardFiles, type HandbackDecision } from "../src/host/guard-files.ts";
import { createRunBook } from "../src/runs/run-book.ts";
import { stubRuntime } from "../src/runs/stub-runtime.ts";
import { cleanupAll, tempHome } from "./harness.ts";

afterEach(cleanupAll);

const TTL_MS = 60_000;
const task = { task: { prompt: "Summarize README.md in one line." } };

function supervisor(options: { handbackDecision?: HandbackDecision; runtimeDelayMs?: number } = {}) {
  let now = Date.parse("2026-10-24T00:00:00Z");
  const sessionDir = tempHome();
  const log = new EventLog();
  const guard = createGuardFiles(sessionDir, { handbackDecision: options.handbackDecision ?? "none" });
  const runtime = stubRuntime({ delayMs: options.runtimeDelayMs ?? 0 });
  const runs = createRunBook({ log, guard, now: () => now, preparedTtlMs: TTL_MS, runtime });
  const info = { version: "0", pid: 1, sessionId: "s", sessionDir, socketPath: "/tmp/x", startedAt: new Date(now).toISOString() };
  const handle = createCommands(info, log, guard, runs);
  const command = async (body: Record<string, unknown>): Promise<any> => handle(body);
  return {
    command,
    sessionDir,
    log,
    advance: (ms: number) => (now += ms),
    async prepare(caller: { agentId: string | null; depth: number } = { agentId: null, depth: 0 }) {
      const r = await command({ op: "run.prepare", caller, input: task });
      expect(r).toMatchObject({ ok: true, value: { status: "prepared" } });
      return r.value.runId as string;
    },
    async launch(runId: string, agentId: string, permissionMode = "default", callerAgentId: string | null = null) {
      expect(await command({ op: "run.claim", runId, callerAgentId })).toMatchObject({ ok: true });
      expect(await command({ op: "run.bind", runId, agentId, permissionMode })).toMatchObject({ ok: true });
    },
    step: (agentId: string) => command({ op: "worker.step", agentId, waitMs: 1000 }),
  };
}

describe("a delegated Run from prepare to Report", () => {
  test("in manual mode the Worker reports once with text, then only says it already reported", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    await s.launch(runId, "agent-w1");

    const first = await s.step("agent-w1");
    expect(first).toMatchObject({ ok: true, value: { kind: "report", via: "text" } });
    expect(first.value.message).toContain(runId);
    expect(await s.command({ op: "run.get", runId })).toMatchObject({ ok: true, value: { status: "completed" } });

    const again = await s.step("agent-w1");
    expect(again).toMatchObject({ ok: true, value: { kind: "end" } });
    expect(again.value.text).toContain("already reported");
  });

  test("a Host Step that comes while Codex works answers pending, and a later one reports", async () => {
    const s = supervisor({ runtimeDelayMs: 200 });
    const runId = await s.prepare();
    await s.launch(runId, "agent-w0");

    expect(await s.command({ op: "worker.step", agentId: "agent-w0", waitMs: 10 })).toMatchObject({
      ok: true,
      value: { kind: "pending", status: "running" },
    });
    expect(await s.command({ op: "worker.step", agentId: "agent-w0", waitMs: 5000 })).toMatchObject({
      ok: true,
      value: { kind: "report" },
    });
  });
});

describe("Report in auto mode", () => {
  test.each(["none", "allow"] as const)(
    "reports through a SubagentHandback Permit whose decision follows --handback-decision %s",
    async (decision) => {
      const s = supervisor({ handbackDecision: decision });
      const runId = await s.prepare();
      await s.launch(runId, "agent-w2", "auto");

      const first = await s.step("agent-w2");
      expect(first).toMatchObject({ ok: true, value: { kind: "report", via: "handback" } });
      const permit = JSON.parse(readFileSync(join(s.sessionDir, "permits", first.value.toolUseId), "utf8"));
      expect(permit).toEqual({ agentId: "agent-w2", tool: "SubagentHandback", decision });

      expect(await s.step("agent-w2")).toMatchObject({ ok: true, value: { kind: "end" } });
      expect(readdirSync(join(s.sessionDir, "permits"))).toHaveLength(1);
    },
  );
});

describe("launching the Worker", () => {
  test("binding writes the Worker to the Worker Roster", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    await s.launch(runId, "agent-w3");
    expect(readdirSync(join(s.sessionDir, "roster"))).toEqual(["agent-w3"]);
    expect(await s.command({ op: "run.get", runId })).toMatchObject({
      ok: true,
      value: { status: "starting", workerAgentId: "agent-w3" },
    });
  });

  test.each([
    ["a runId nobody prepared", (_: string) => ({ runId: "run_fake", callerAgentId: null }), "INVALID_INPUT"],
    ["another caller", (runId: string) => ({ runId, callerAgentId: "agent-other" }), "STATE_CONFLICT"],
  ])("refuses %s", async (_label, args, code) => {
    const s = supervisor();
    const runId = await s.prepare();
    for (const op of ["run.admit", "run.claim"]) {
      expect(await s.command({ op, ...args(runId) })).toMatchObject({ ok: false, error: { code } });
    }
    expect(await s.command({ op: "run.get", runId })).toMatchObject({ ok: true, value: { status: "prepared" } });
  });

  test("admits only the caller that prepared the Run, a subagent included", async () => {
    const s = supervisor();
    const runId = await s.prepare({ agentId: "agent-sub", depth: 1 });
    expect(await s.command({ op: "run.admit", runId, callerAgentId: null })).toMatchObject({ ok: false });
    expect(await s.command({ op: "run.admit", runId, callerAgentId: "agent-sub" })).toMatchObject({ ok: true });
    expect(await s.command({ op: "run.get", runId })).toMatchObject({ ok: true, value: { depth: 2 } });
  });

  test("a claimed runId cannot start a second Worker even when its bind never arrived", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    expect(await s.command({ op: "run.claim", runId, callerAgentId: null })).toMatchObject({ ok: true });

    for (const op of ["run.admit", "run.claim"]) {
      expect(await s.command({ op, runId, callerAgentId: null })).toMatchObject({
        ok: false,
        error: { code: "STATE_CONFLICT" },
      });
    }
  });

  test("a used runId cannot start a second Worker", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    await s.launch(runId, "agent-w4");
    expect(await s.command({ op: "run.claim", runId, callerAgentId: null })).toMatchObject({ ok: false });
    expect(await s.command({ op: "run.bind", runId, agentId: "agent-w5" })).toMatchObject({ ok: false });
  });

  test("a Worker the host refused to start fails its Run", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    await s.command({ op: "run.claim", runId, callerAgentId: null });
    expect(await s.command({ op: "run.abandon", runId, reason: "zero tools" })).toMatchObject({ ok: true });
    expect(await s.command({ op: "run.get", runId })).toMatchObject({ ok: true, value: { status: "failed" } });
  });

  test("an agent that no Run bound gets no Host Step", async () => {
    const s = supervisor();
    expect(await s.step("agent-stranger")).toMatchObject({ ok: false, error: { code: "STATE_CONFLICT" } });
  });
});

describe("prepared Runs", () => {
  test("expire once preparedTtl passes without a Worker", async () => {
    const s = supervisor();
    const runId = await s.prepare();
    s.advance(TTL_MS - 1);
    expect(await s.command({ op: "run.admit", runId, callerAgentId: null })).toMatchObject({ ok: true });
    s.advance(1);
    expect(await s.command({ op: "run.claim", runId, callerAgentId: null })).toMatchObject({
      ok: false,
      error: { code: "RUN_EXPIRED" },
    });
    expect(await s.command({ op: "run.get", runId })).toMatchObject({ ok: true, value: { status: "expired" } });
  });

  test("an expiry is published as an event", async () => {
    const s = supervisor();
    await s.prepare();
    s.advance(TTL_MS);
    await s.command({ op: "run.sweep" });
    expect(s.log.page(0, 1 << 20).events.map((e) => e.kind)).toEqual(["run.prepared", "run.expired"]);
  });
});

describe("delegate admission", () => {
  test("a caller at depth 3 gets DEPTH_EXCEEDED and no Run", async () => {
    const s = supervisor();
    const r = await s.command({ op: "run.prepare", caller: { agentId: "agent-d3", depth: 3 }, input: task });
    expect(r).toMatchObject({ ok: false, error: { code: "DEPTH_EXCEEDED" } });
    expect(s.log.cursor).toBe(0);
  });

  test("a looser permission than the default needs a grant", async () => {
    const s = supervisor();
    const input = { ...task, permissions: { approvalPolicy: "never" } };
    const r = await s.command({ op: "run.prepare", caller: { agentId: null, depth: 0 }, input });
    expect(r).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
  });

  test("an input outside the contract is refused", async () => {
    const s = supervisor();
    const r = await s.command({ op: "run.prepare", caller: { agentId: null, depth: 0 }, input: { ...task, env: {} } });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { path: "$.env" } } });
  });
});
