import { s, validate, type Infer } from "../schema.ts";
import {
  WORKSPACE_ISOLATIONS,
  approvalPolicySchema,
  artifactRefSchema,
  executionSchema,
  sandboxSchema,
} from "./common.ts";

export const delegateInputSchema = s.object({
  task: s.object({
    title: s.optional(s.string({ minLength: 1 })),
    prompt: s.string({ minLength: 1 }),
  }),
  execution: s.optional(executionSchema),
  workspace: s.optional(
    s.object({
      directory: s.string({ minLength: 1 }),
      isolation: s.optional(s.enum(WORKSPACE_ISOLATIONS)),
    }),
  ),
  permissions: s.optional(
    s.object({
      sandbox: s.optional(sandboxSchema),
      approvalPolicy: s.optional(approvalPolicySchema),
    }),
  ),
  context: s.optional(
    s.object({
      artifacts: s.optional(s.array(artifactRefSchema)),
    }),
  ),
});

export type DelegateInput = Infer<typeof delegateInputSchema>;

export const validateDelegateInput = (value: unknown) => validate(delegateInputSchema, value);
