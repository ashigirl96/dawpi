import { bridgeError, type Outcome } from "@dawpi/contracts";
import type { EventLog } from "./control/event-log.ts";

export const MAX_PING_TOKEN_BYTES = 64 * 1024;

export type SupervisorInfo = {
  version: string;
  pid: number;
  sessionId: string;
  sessionDir: string;
  socketPath: string;
  startedAt: string;
};

export function createCommands(info: SupervisorInfo, log: EventLog) {
  return (body: Record<string, unknown>): Outcome<unknown> => {
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
      default:
        return {
          ok: false,
          error: bridgeError("UNSUPPORTED_REQUEST", `unknown op ${JSON.stringify(body.op)}`, { details: { path: "op" } }),
        };
    }
  };
}
