import { bridgeError, type BridgeError, type Outcome } from "@dawpi/contracts";
import type { EventLog } from "./event-log.ts";

export const MAX_POLL_MS = 30_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
const PAGE_ENVELOPE_BYTES = 1024;

export type CommandHandler = (body: Record<string, unknown>) => Outcome<unknown> | Promise<Outcome<unknown>>;

const reply = (outcome: Outcome<unknown>, status = 200) => Response.json(outcome, { status });
const fail = (error: BridgeError, status: number) => reply({ ok: false, error }, status);

export function serveControl(options: { socketPath: string; log: EventLog; command: CommandHandler }) {
  const { log, command } = options;
  // Bun's 10 s default idle timeout would cut a 30 s long poll; its types omit idleTimeout for unix sockets.
  const serveOptions = {
    unix: options.socketPath,
    idleTimeout: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/command" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return fail(bridgeError("INVALID_INPUT", "command body is not JSON"), 400);
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return fail(bridgeError("INVALID_INPUT", "command body must be an object"), 400);
        }
        return reply(await command(body as Record<string, unknown>));
      }
      if (url.pathname === "/events" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
        if (!Number.isInteger(after) || after < 0 || !Number.isFinite(waitMs) || waitMs < 0) {
          return fail(bridgeError("INVALID_INPUT", "after and waitMs must be non-negative integers"), 400);
        }
        if (after > log.cursor) {
          return fail(
            bridgeError("STATE_CONFLICT", "cursor is ahead of this Supervisor", { details: { cursor: log.cursor } }),
            409,
          );
        }
        await log.wait(after, Math.min(waitMs, MAX_POLL_MS));
        return reply({ ok: true, value: log.page(after, MAX_RESPONSE_BYTES - PAGE_ENVELOPE_BYTES) });
      }
      return fail(bridgeError("UNSUPPORTED_REQUEST", `no route ${req.method} ${url.pathname}`), 404);
    },
  };
  return Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);
}
