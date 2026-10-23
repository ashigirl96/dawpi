import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hooks from "../../packages/claude-mod/hooks/hooks.json" with { type: "json" };
import { cleanupAll, onCleanup, start, tempHome } from "../../packages/supervisor/test/harness.ts";

afterEach(cleanupAll);

const PLUGIN_ROOT = join(import.meta.dir, "../../packages/claude-mod");
const GUARD_COMMAND = hooks.hooks.PreToolUse[0]!.hooks[0]!.command;

type HookInput = { agent_id?: string; tool_name: string; tool_use_id: string; tool_input?: unknown };

async function runGuard(home: string, input: HookInput, pluginRoot = PLUGIN_ROOT) {
  const proc = Bun.spawn(["sh", "-c", GUARD_COMMAND], {
    stdin: new Blob([JSON.stringify({ session_id: "sess-test", hook_event_name: "PreToolUse", tool_input: {}, ...input })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CODEX_BRIDGE_HOME: home },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const decision = stdout.trim() === "" ? undefined : JSON.parse(stdout).hookSpecificOutput?.permissionDecision;
  // Claude Code blocks a PreToolUse call on exit status 2 as well as on a deny decision.
  return { decision: code === 2 ? "deny" : decision, code, stderr };
}

describe("Guard", () => {
  test("returns no decision for an agent not on the Worker Roster", async () => {
    const home = tempHome();
    const r = await runGuard(home, { agent_id: "agent-main-sub", tool_name: "Bash", tool_use_id: "toolu_01abc" });
    expect(r).toMatchObject({ decision: undefined, code: 0 });
    const main = await runGuard(home, { tool_name: "Bash", tool_use_id: "toolu_01abd" });
    expect(main).toMatchObject({ decision: undefined, code: 0 });
  });

  test("allows a Worker call that holds a Permit, once", async () => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const issued = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "Bash" });
    const toolUseId = issued.json.value.toolUseId;

    const first = await runGuard(s.home, { agent_id: "agent-w1", tool_name: "Bash", tool_use_id: toolUseId });
    expect(first.decision).toBe("allow");
    const again = await runGuard(s.home, { agent_id: "agent-w1", tool_name: "Bash", tool_use_id: toolUseId });
    expect(again.decision).toBe("deny");
  });

  test.each(["Bash", "Agent", "Edit", "SubagentHandback"])("denies a Worker's %s call without a Permit", async tool => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const r = await runGuard(s.home, { agent_id: "agent-w1", tool_name: tool, tool_use_id: "toolu_01model" });
    expect(r.decision).toBe("deny");
  });

  test("denies a Worker that presents another Worker's Permit", async () => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    await s.command({ op: "roster.add", agentId: "agent-w2" });
    const issued = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "Bash" });
    const r = await runGuard(s.home, { agent_id: "agent-w2", tool_name: "Bash", tool_use_id: issued.json.value.toolUseId });
    expect(r.decision).toBe("deny");
  });

  test("returns no decision for a SubagentHandback with a Permit by default", async () => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const issued = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "SubagentHandback" });
    const id = issued.json.value.toolUseId;
    const r = await runGuard(s.home, { agent_id: "agent-w1", tool_name: "SubagentHandback", tool_use_id: id });
    expect(r).toMatchObject({ decision: undefined, code: 0 });
    const again = await runGuard(s.home, { agent_id: "agent-w1", tool_name: "SubagentHandback", tool_use_id: id });
    expect(again.decision).toBe("deny");
  });

  test("allows a SubagentHandback with a Permit when the Supervisor is set to allow it", async () => {
    const s = await start({ extraArgs: ["--handback-decision", "allow"] });
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const issued = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "SubagentHandback" });
    const r = await runGuard(s.home, {
      agent_id: "agent-w1",
      tool_name: "SubagentHandback",
      tool_use_id: issued.json.value.toolUseId,
    });
    expect(r.decision).toBe("allow");
  });

  test("still denies a Roster Worker and passes main when guard.sh is missing (T34)", async () => {
    const s = await start();
    await s.command({ op: "roster.add", agentId: "agent-w1" });
    const issued = await s.command({ op: "permit.issue", agentId: "agent-w1", tool: "Bash" });
    const noScript = mkdtempSync(join(tmpdir(), "cbx-plugin-"));
    onCleanup(() => Bun.spawnSync(["rm", "-rf", noScript]));

    const worker = await runGuard(
      s.home,
      { agent_id: "agent-w1", tool_name: "Bash", tool_use_id: issued.json.value.toolUseId },
      noScript,
    );
    expect(worker.decision).toBe("deny");
    const main = await runGuard(s.home, { tool_name: "Bash", tool_use_id: "toolu_01main" }, noScript);
    expect(main).toMatchObject({ decision: undefined, code: 0 });
    const sub = await runGuard(s.home, { agent_id: "agent-w10", tool_name: "Bash", tool_use_id: "toolu_01s" }, noScript);
    expect(sub).toMatchObject({ decision: undefined, code: 0 });
  });
});
