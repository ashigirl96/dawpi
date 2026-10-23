import { s, type Infer } from "../schema.ts";

export const runIdSchema = s.string({ minLength: 1 });

export const modelSchema = s.string({ minLength: 1 });

// Catalog membership is checked by the Supervisor; ultra is refused even when the catalog lists it, because the provider bills it as max.
export const effortSchema = s.string({
  minLength: 1,
  forbidden: { values: ["ultra"], reason: "effort ultra is not accepted" },
});

export const executionSchema = s.object({
  model: s.optional(modelSchema),
  effort: s.optional(effortSchema),
});
export type Execution = Infer<typeof executionSchema>;

export const SANDBOX_MODES = ["read-only", "workspace-write"] as const;
export const sandboxSchema = s.enum(SANDBOX_MODES);
export type SandboxMode = Infer<typeof sandboxSchema>;

export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export const approvalPolicySchema = s.enum(APPROVAL_POLICIES);
export type ApprovalPolicy = Infer<typeof approvalPolicySchema>;

export const WORKSPACE_ISOLATIONS = ["shared-read", "isolated-write", "exclusive-write"] as const;

export const lineRangeSchema = s.object({
  startLine: s.integer({ minimum: 1 }),
  endLine: s.integer({ minimum: 1 }),
});

export const artifactRefSchema = s.object({
  path: s.string({ minLength: 1 }),
  contentHash: s.optional(s.string({ minLength: 1 })),
  range: s.optional(lineRangeSchema),
});
export type ArtifactRef = Infer<typeof artifactRefSchema>;

export const RUN_STATUSES = [
  "prepared",
  "starting",
  "running",
  "waiting_children",
  "waiting_user",
  "finalizing",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export const runStatusSchema = s.enum(RUN_STATUSES);
export type RunStatus = Infer<typeof runStatusSchema>;
