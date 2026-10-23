import { s, validate, type Infer } from "../schema.ts";
import { artifactRefSchema, runIdSchema, runStatusSchema } from "./common.ts";

export const runSchema = s.object({
  id: runIdSchema,
  parentRunId: s.nullable(runIdSchema),
  rootRunId: runIdSchema,
  depth: s.integer({ minimum: 1 }),
  caller: s.object({
    kind: s.enum(["claude", "codex", "user"]),
    agentId: s.nullable(s.string({ minLength: 1 })),
  }),
  conversationId: s.string({ minLength: 1 }),
  predecessorRunId: s.optional(runIdSchema),
  workerAgentId: s.optional(s.string({ minLength: 1 })),
  specRevision: s.integer({ minimum: 0 }),
  status: runStatusSchema,
  preparedDeadline: s.string({ minLength: 1 }),
  resultId: s.optional(s.string({ minLength: 1 })),
});
export type Run = Infer<typeof runSchema>;

export const RUN_OUTCOMES = ["succeeded", "failed", "cancelled", "incomplete"] as const;
export const runOutcomeSchema = s.enum(RUN_OUTCOMES);
export type RunOutcome = Infer<typeof runOutcomeSchema>;

export const checkResultSchema = s.object({
  name: s.string({ minLength: 1 }),
  status: s.enum(["passed", "failed", "not-run"]),
  // A claimed pass counts as verified only when a matching execution record exists.
  verified: s.boolean(),
});
export type CheckResult = Infer<typeof checkResultSchema>;

export const runResultSchema = s.object({
  resultId: s.string({ minLength: 1 }),
  runId: runIdSchema,
  outcome: runOutcomeSchema,
  summary: s.string(),
  artifacts: s.array(artifactRefSchema),
  checks: s.array(checkResultSchema),
  childResults: s.array(
    s.object({
      runId: runIdSchema,
      resultId: s.string({ minLength: 1 }),
      outcome: runOutcomeSchema,
    }),
  ),
  hasUnresolvedIssues: s.boolean(),
});
export type RunResult = Infer<typeof runResultSchema>;

export const validateRun = (value: unknown) => validate(runSchema, value);
export const validateRunResult = (value: unknown) => validate(runResultSchema, value);
