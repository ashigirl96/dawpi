import { bridgeError, type BridgeError } from "./errors.ts";
import type { DelegateInput } from "./schemas/delegate.ts";
import type { ApprovalPolicy, SandboxMode } from "./schemas/common.ts";

export type PermissionGrant = {
  sandbox?: readonly SandboxMode[];
  approvalPolicy?: readonly ApprovalPolicy[];
};

const ALLOWED_WITHOUT_GRANT = {
  sandbox: ["read-only"],
  approvalPolicy: ["untrusted", "on-request"],
} as const satisfies { [K in keyof PermissionGrant]-?: PermissionGrant[K] };

export function checkPermissionGrant(
  permissions: DelegateInput["permissions"],
  grant: PermissionGrant,
): BridgeError | null {
  for (const field of ["sandbox", "approvalPolicy"] as const) {
    const requested = permissions?.[field];
    if (requested === undefined) continue;
    const allowed: readonly string[] = [...ALLOWED_WITHOUT_GRANT[field], ...(grant[field] ?? [])];
    if (allowed.includes(requested)) continue;
    return bridgeError("POLICY_DENIED", `${field} ${requested} needs a user grant`, {
      retry: "after-user",
      details: { field, requested, allowed },
    });
  }
  return null;
}
