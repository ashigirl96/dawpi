import { randomBytes } from "node:crypto";
import {
  bridgeError,
  checkPermissionGrant,
  validateDelegateInput,
  type BridgeError,
  type DelegateInput,
  type Outcome,
  type Run,
  type RunResult,
} from "@dawpi/contracts";
import type { EventLog } from "../control/event-log.ts";
import type { GuardFiles } from "../host/guard-files.ts";
import { stubRuntime, type CodexRuntime } from "./stub-runtime.ts";

// Claude Code gives no Agent tool below depth 3, so a Run there could never start a Worker.
export const MAX_RUN_DEPTH = 3;
export const DEFAULT_PREPARED_TTL_MS = 5 * 60 * 1000;

const HANDBACK = "SubagentHandback";
// The Mod's $.http.fetch gives up after 30 s, so a Host Step's wait ends before that.
const MAX_STEP_WAIT_MS = 25_000;
const TERMINAL = new Set<Run["status"]>(["completed", "failed", "cancelled", "expired"]);

export type Caller = { agentId: string | null; depth: number };

export type WorkerState = {
  agentId: string;
  runId: string;
  permissionMode: string;
  reported: boolean;
};

export type StepAction =
  | { kind: "pending"; status: Run["status"] }
  | { kind: "report"; via: "text"; message: string }
  | { kind: "report"; via: "handback"; message: string; toolUseId: string }
  | { kind: "end"; text: string };

type Entry = { run: Run; input: DelegateInput; result?: RunResult; settled?: Promise<void> };

const fail = (error: BridgeError): Outcome<never> => ({ ok: false, error });

export function createRunBook(options: {
  log: EventLog;
  guard: GuardFiles;
  now?: () => number;
  preparedTtlMs?: number;
  runtime?: CodexRuntime;
}) {
  const { log, guard } = options;
  const now = options.now ?? Date.now;
  const ttl = options.preparedTtlMs ?? DEFAULT_PREPARED_TTL_MS;
  const runtime = options.runtime ?? stubRuntime();
  const runs = new Map<string, Entry>();
  const workers = new Map<string, WorkerState>();

  const emit = (run: Run, kind: string, payload: Record<string, unknown> = {}) =>
    log.append({ origin: "supervisor", runId: run.id, kind, payload: { status: run.status, ...payload } });

  const move = (run: Run, status: Run["status"], payload?: Record<string, unknown>) => {
    run.status = status;
    emit(run, `run.${status}`, payload);
  };

  function expireOverdue(): void {
    for (const { run } of runs.values()) {
      if (run.status === "prepared" && Date.parse(run.preparedDeadline) <= now()) move(run, "expired");
    }
  }

  function lookup(runId: unknown): Outcome<Entry> {
    expireOverdue();
    const entry = typeof runId === "string" ? runs.get(runId) : undefined;
    if (entry === undefined) return fail(bridgeError("INVALID_INPUT", "no Run has this runId", { details: { path: "runId" } }));
    return { ok: true, value: entry };
  }

  // The three conditions of v2 7.2: a prepared Run, launched by the agent that prepared it.
  function admissible(runId: unknown, callerAgentId: unknown): Outcome<Entry> {
    const found = lookup(runId);
    if (!found.ok) return found;
    const { run } = found.value;
    if (run.status === "expired") return fail(bridgeError("RUN_EXPIRED", "the Run expired before a Worker started", { runId: run.id }));
    if (run.status !== "prepared") {
      return fail(bridgeError("STATE_CONFLICT", `the Run is ${run.status}, not prepared`, { runId: run.id }));
    }
    if (run.caller.agentId !== (callerAgentId ?? null)) {
      return fail(bridgeError("STATE_CONFLICT", "the Run was prepared by another caller", { runId: run.id }));
    }
    return found;
  }

  function activate(entry: Entry): void {
    move(entry.run, "running");
    entry.settled = runtime.start(entry.run, entry.input).then(
      (result) => {
        entry.result = result;
        entry.run.resultId = result.resultId;
        move(entry.run, "completed", { resultId: result.resultId });
      },
      (err: unknown) => move(entry.run, "failed", { error: String(err) }),
    );
  }

  function report(worker: WorkerState, entry: Entry): StepAction {
    worker.reported = true;
    const { run } = entry;
    const summary = entry.result?.summary ?? `the Run ended ${run.status} without a result`;
    const message = `Codex Bridge Report for ${run.id} (${run.status}):\n${summary}`;
    if (worker.permissionMode === "auto") {
      const toolUseId = guard.issuePermit({ agentId: worker.agentId, tool: HANDBACK });
      emit(run, "run.reported", { via: "handback", toolUseId });
      return { kind: "report", via: "handback", message, toolUseId };
    }
    emit(run, "run.reported", { via: "text" });
    return { kind: "report", via: "text", message };
  }

  return {
    expireOverdue,

    prepare(body: { caller?: unknown; input?: unknown }): Outcome<{ runId: string; status: "prepared"; depth: number; preparedDeadline: string }> {
      const caller = body.caller as Caller | undefined;
      if (
        caller === undefined ||
        !(caller.agentId === null || typeof caller.agentId === "string") ||
        !Number.isInteger(caller.depth) ||
        caller.depth < 0
      ) {
        return fail(bridgeError("INVALID_INPUT", "caller must be { agentId, depth }", { details: { path: "caller" } }));
      }
      const depth = caller.depth + 1;
      if (depth > MAX_RUN_DEPTH) {
        return fail(
          bridgeError("DEPTH_EXCEEDED", `a Run at depth ${depth} could not start a Worker; the limit is ${MAX_RUN_DEPTH}`, {
            details: { depth, maxDepth: MAX_RUN_DEPTH },
          }),
        );
      }
      const valid = validateDelegateInput(body.input);
      if (!valid.ok) return valid;
      const denied = checkPermissionGrant(valid.value.permissions, {});
      if (denied !== null) return fail(denied);

      const id = `run_${randomBytes(8).toString("hex")}`;
      const run: Run = {
        id,
        parentRunId: null,
        rootRunId: id,
        depth,
        caller: { kind: "claude", agentId: caller.agentId },
        conversationId: `conv_${randomBytes(8).toString("hex")}`,
        specRevision: 0,
        status: "prepared",
        preparedDeadline: new Date(now() + ttl).toISOString(),
      };
      runs.set(id, { run, input: valid.value });
      emit(run, "run.prepared", { depth, callerAgentId: caller.agentId });
      return { ok: true, value: { runId: id, status: "prepared", depth, preparedDeadline: run.preparedDeadline } };
    },

    admit(body: { runId?: unknown; callerAgentId?: unknown }): Outcome<{ runId: string }> {
      const found = admissible(body.runId, body.callerAgentId);
      return found.ok ? { ok: true, value: { runId: found.value.run.id } } : found;
    },

    // Claiming before the host starts the Worker means a second Agent call for the same runId is refused even when the bind never arrives.
    claim(body: { runId?: unknown; callerAgentId?: unknown }): Outcome<{ runId: string }> {
      const found = admissible(body.runId, body.callerAgentId);
      if (!found.ok) return found;
      move(found.value.run, "starting");
      return { ok: true, value: { runId: found.value.run.id } };
    },

    bind(body: { runId?: unknown; agentId?: unknown; permissionMode?: unknown }): Outcome<{ runId: string; agentId: string }> {
      const found = lookup(body.runId);
      if (!found.ok) return found;
      const { run } = found.value;
      const agentId = body.agentId;
      if (typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) {
        return fail(bridgeError("INVALID_INPUT", "agentId must match [A-Za-z0-9_-]{1,128}", { details: { path: "agentId" } }));
      }
      if (run.status !== "starting" || run.workerAgentId !== undefined) {
        return fail(bridgeError("STATE_CONFLICT", `the Run is ${run.status} and cannot bind a Worker`, { runId: run.id }));
      }
      guard.addToRoster(agentId);
      run.workerAgentId = agentId;
      const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : "default";
      workers.set(agentId, { agentId, runId: run.id, permissionMode, reported: false });
      emit(run, "run.bound", { agentId, permissionMode });
      return { ok: true, value: { runId: run.id, agentId } };
    },

    abandon(body: { runId?: unknown; reason?: unknown }): Outcome<{ runId: string }> {
      const found = lookup(body.runId);
      if (!found.ok) return found;
      const { run } = found.value;
      if (run.status !== "starting" || run.workerAgentId !== undefined) {
        return fail(bridgeError("STATE_CONFLICT", `the Run is ${run.status}`, { runId: run.id }));
      }
      move(run, "failed", { error: bridgeError("HOST_BINDING_FAILED", String(body.reason ?? "the host did not start the Worker")) });
      return { ok: true, value: { runId: run.id } };
    },

    async step(body: { agentId?: unknown; waitMs?: unknown }): Promise<Outcome<StepAction>> {
      const worker = typeof body.agentId === "string" ? workers.get(body.agentId) : undefined;
      if (worker === undefined) {
        return fail(bridgeError("STATE_CONFLICT", "this agent is not a bound Worker", { details: { path: "agentId" } }));
      }
      const entry = runs.get(worker.runId)!;
      if (worker.reported) {
        return { ok: true, value: { kind: "end", text: `Codex Bridge: ${entry.run.id} already reported.` } };
      }
      if (entry.run.status === "starting") activate(entry);
      if (!TERMINAL.has(entry.run.status) && entry.settled !== undefined) {
        const waitMs = typeof body.waitMs === "number" && body.waitMs > 0 ? Math.min(body.waitMs, MAX_STEP_WAIT_MS) : 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([entry.settled, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
        clearTimeout(timer);
      }
      if (!TERMINAL.has(entry.run.status)) return { ok: true, value: { kind: "pending", status: entry.run.status } };
      return { ok: true, value: report(worker, entry) };
    },

    get(body: { runId?: unknown }): Outcome<Run> {
      const found = lookup(body.runId);
      return found.ok ? { ok: true, value: { ...found.value.run } } : found;
    },
  };
}

export type RunBook = ReturnType<typeof createRunBook>;
