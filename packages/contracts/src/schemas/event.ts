import { s, validate, type Infer } from "../schema.ts";
import { runIdSchema } from "./common.ts";

export const bridgeEventSchema = s.object({
  schemaVersion: s.literal(1),
  runId: runIdSchema,
  seq: s.integer({ minimum: 0 }),
  observedAt: s.string({ minLength: 1 }),
  origin: s.enum(["codex", "host", "supervisor"]),
  kind: s.string({ minLength: 1 }),
  providerRef: s.optional(
    s.object({
      threadId: s.string({ minLength: 1 }),
      turnId: s.optional(s.string({ minLength: 1 })),
      itemId: s.optional(s.string({ minLength: 1 })),
    }),
  ),
  payload: s.unknown(),
});
export type BridgeEvent = Infer<typeof bridgeEventSchema>;

export const validateBridgeEvent = (value: unknown) => validate(bridgeEventSchema, value);

// Supervisor-scope events (start, ping) belong to no Run, so they carry no runId.
export const supervisorEventSchema = s.object({
  schemaVersion: s.literal(1),
  seq: s.integer({ minimum: 0 }),
  observedAt: s.string({ minLength: 1 }),
  origin: s.literal("supervisor"),
  kind: s.string({ minLength: 1 }),
  payload: s.unknown(),
});
export type SupervisorEvent = Infer<typeof supervisorEventSchema>;

export type ControlEvent = BridgeEvent | SupervisorEvent;
