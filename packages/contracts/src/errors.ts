export const BRIDGE_ERROR_CODES = [
  "INVALID_INPUT",
  "MODEL_UNAVAILABLE",
  "EFFORT_UNSUPPORTED",
  "POLICY_DENIED",
  "HOST_DENIED",
  "CAPACITY_EXHAUSTED",
  "DEPTH_EXCEEDED",
  "HOST_CAPABILITY_MISSING",
  "HOST_BINDING_FAILED",
  "RUN_EXPIRED",
  "PROVIDER_CAPABILITY_MISSING",
  "SELF_DELEGATION_DETECTED",
  "APPROVAL_REQUIRED",
  "APPROVAL_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "STATE_CONFLICT",
  "RUNTIME_EXITED",
  "SUPERVISOR_RESTARTED",
  "UNSUPPORTED_REQUEST",
  "CANCELLED",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export const RETRY_HINTS = ["never", "after-capacity", "after-auth", "after-user"] as const;

export type RetryHint = (typeof RETRY_HINTS)[number];

export type BridgeError = {
  code: BridgeErrorCode;
  message: string;
  retry: RetryHint;
  operationId?: string;
  runId?: string;
  details?: Record<string, unknown>;
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  extra: Omit<BridgeError, "code" | "message" | "retry"> & { retry?: RetryHint } = {},
): BridgeError {
  const { retry = "never", ...rest } = extra;
  return { code, message, retry, ...rest };
}
