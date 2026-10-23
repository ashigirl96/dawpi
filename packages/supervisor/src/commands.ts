import { bridgeError, type Outcome } from "@dawpi/contracts";
import type { EventLog } from "./control/event-log.ts";
import { isAgentId, type GuardFiles } from "./host/guard-files.ts";
import type { RunBook } from "./runs/run-book.ts";

export const MAX_PING_TOKEN_BYTES = 64 * 1024;

export type SupervisorInfo = {
  version: string;
  pid: number;
  sessionId: string;
  sessionDir: string;
  socketPath: string;
  startedAt: string;
};

const invalidAgentId = (): Outcome<never> => ({
  ok: false,
  error: bridgeError("INVALID_INPUT", "agentId must match [A-Za-z0-9_-]{1,128}", { details: { path: "agentId" } }),
});

export function createCommands(info: SupervisorInfo, log: EventLog, guard: GuardFiles, runs: RunBook) {
  return (body: Record<string, unknown>): Outcome<unknown> | Promise<Outcome<unknown>> => {
    switch (body.op) {
      case "status":
        return { ok: true, value: { ...info, uptimeMs: Date.now() - Date.parse(info.startedAt), cursor: log.cursor } };
      case "ping": {
        const token = body.token ?? "";
        if (typeof token !== "string" || Buffer.byteLength(token) > MAX_PING_TOKEN_BYTES) {
          return {
            ok: false,
            error: bridgeError("INVALID_INPUT", `token must be a string of at most ${MAX_PING_TOKEN_BYTES} bytes`, {
              details: { path: "token" },
            }),
          };
        }
        const event = log.append({ origin: "supervisor", kind: "ping", payload: { token } });
        return { ok: true, value: { seq: event.seq } };
      }
      case "roster.add": {
        if (!isAgentId(body.agentId)) return invalidAgentId();
        guard.addToRoster(body.agentId);
        return { ok: true, value: { agentId: body.agentId } };
      }
      case "permit.issue": {
        if (!isAgentId(body.agentId)) return invalidAgentId();
        if (typeof body.tool !== "string" || body.tool.length === 0) {
          return { ok: false, error: bridgeError("INVALID_INPUT", "tool must be a tool name", { details: { path: "tool" } }) };
        }
        if (!guard.isOnRoster(body.agentId)) {
          return { ok: false, error: bridgeError("STATE_CONFLICT", "the agent is not on the Worker Roster") };
        }
        return { ok: true, value: { toolUseId: guard.issuePermit({ agentId: body.agentId, tool: body.tool }) } };
      }
      case "run.prepare":
        return runs.prepare(body);
      case "run.admit":
        return runs.admit(body);
      case "run.claim":
        return runs.claim(body);
      case "run.bind":
        return runs.bind(body);
      case "run.abandon":
        return runs.abandon(body);
      case "run.sweep":
        runs.expireOverdue();
        return { ok: true, value: {} };
      case "run.get":
        return runs.get(body);
      case "worker.step":
        return runs.step(body);
      default:
        return {
          ok: false,
          error: bridgeError("UNSUPPORTED_REQUEST", `unknown op ${JSON.stringify(body.op)}`, { details: { path: "op" } }),
        };
    }
  };
}
