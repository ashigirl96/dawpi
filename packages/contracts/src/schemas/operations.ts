import { s, validate, type Infer } from "../schema.ts";
import {
  WORKSPACE_ISOLATIONS,
  approvalPolicySchema,
  executionSchema,
  modelSchema,
  effortSchema,
  runIdSchema,
  runStatusSchema,
  sandboxSchema,
} from "./common.ts";
import { runResultSchema, runSchema } from "./run.ts";

export const resolvedSettingsSchema = s.object({
  execution: s.object({ model: modelSchema, effort: effortSchema }),
  permissions: s.object({ sandbox: sandboxSchema, approvalPolicy: approvalPolicySchema }),
  workspace: s.object({ directory: s.string({ minLength: 1 }), isolation: s.enum(WORKSPACE_ISOLATIONS) }),
});
export type ResolvedSettings = Infer<typeof resolvedSettingsSchema>;

export const delegateResultSchema = s.object({
  runId: runIdSchema,
  status: s.enum(["prepared", "accepted"]),
  settings: resolvedSettingsSchema,
  instructions: s.string(),
});
export type DelegateResult = Infer<typeof delegateResultSchema>;

export const inspectInputSchema = s.object({ runId: runIdSchema });
export type InspectInput = Infer<typeof inspectInputSchema>;

export const inspectResultSchema = s.object({
  run: runSchema,
  settings: resolvedSettingsSchema,
  children: s.array(s.object({ runId: runIdSchema, status: runStatusSchema })),
});
export type InspectResult = Infer<typeof inspectResultSchema>;

export const waitInputSchema = s.object({
  runIds: s.array(runIdSchema, { minItems: 1 }),
  mode: s.enum(["all", "any"]),
  timeoutMs: s.optional(s.integer({ minimum: 0 })),
});
export type WaitInput = Infer<typeof waitInputSchema>;

export const waitResultSchema = s.object({
  completed: s.array(runResultSchema),
  pending: s.array(runIdSchema),
});
export type WaitResult = Infer<typeof waitResultSchema>;

export const sendInputSchema = s.object({
  runId: runIdSchema,
  text: s.string({ minLength: 1 }),
  delivery: s.optional(s.enum(["next-turn", "active-turn"])),
});
export type SendInput = Infer<typeof sendInputSchema>;

export const sendResultSchema = s.object({
  messageId: s.string({ minLength: 1 }),
  status: s.enum(["queued", "accepted"]),
});
export type SendResult = Infer<typeof sendResultSchema>;

export const configureInputSchema = s.object({
  runId: runIdSchema,
  expectedRevision: s.integer({ minimum: 0 }),
  patch: s.object({ execution: s.optional(executionSchema) }),
  apply: s.optional(s.literal("next-turn")),
});
export type ConfigureInput = Infer<typeof configureInputSchema>;

export const configureResultSchema = s.object({
  runId: runIdSchema,
  revision: s.integer({ minimum: 0 }),
  apply: s.literal("next-turn"),
});
export type ConfigureResult = Infer<typeof configureResultSchema>;

export const cancelInputSchema = s.object({
  runId: runIdSchema,
  reason: s.string({ minLength: 1 }),
});
export type CancelInput = Infer<typeof cancelInputSchema>;

export const cancelResultSchema = s.object({
  runId: runIdSchema,
  status: runStatusSchema,
});
export type CancelResult = Infer<typeof cancelResultSchema>;

export const validateInspectInput = (value: unknown) => validate(inspectInputSchema, value);
export const validateWaitInput = (value: unknown) => validate(waitInputSchema, value);
export const validateSendInput = (value: unknown) => validate(sendInputSchema, value);
export const validateConfigureInput = (value: unknown) => validate(configureInputSchema, value);
export const validateCancelInput = (value: unknown) => validate(cancelInputSchema, value);
