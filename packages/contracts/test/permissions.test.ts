import { describe, expect, test } from "bun:test";
import { checkPermissionGrant } from "../src/index.ts";

describe("permission grant", () => {
  test("allows the defaults and stricter values without a grant", () => {
    expect(checkPermissionGrant(undefined, {})).toBeNull();
    expect(checkPermissionGrant({ sandbox: "read-only", approvalPolicy: "on-request" }, {})).toBeNull();
    expect(checkPermissionGrant({ approvalPolicy: "untrusted" }, {})).toBeNull();
  });

  test("denies approvalPolicy never without a grant", () => {
    expect(checkPermissionGrant({ approvalPolicy: "never" }, {})).toMatchObject({
      code: "POLICY_DENIED",
      retry: "after-user",
      details: { field: "approvalPolicy", requested: "never", allowed: ["untrusted", "on-request"] },
    });
  });

  test("denies workspace-write without a grant", () => {
    expect(checkPermissionGrant({ sandbox: "workspace-write" }, {})).toMatchObject({
      code: "POLICY_DENIED",
      details: { field: "sandbox", requested: "workspace-write", allowed: ["read-only"] },
    });
  });

  test("allows looser values the grant names", () => {
    const grant = { sandbox: ["workspace-write"], approvalPolicy: ["never"] } as const;
    expect(checkPermissionGrant({ sandbox: "workspace-write", approvalPolicy: "never" }, grant)).toBeNull();
  });

  test("a grant for one field does not loosen the other", () => {
    expect(
      checkPermissionGrant({ sandbox: "workspace-write", approvalPolicy: "never" }, { sandbox: ["workspace-write"] }),
    ).toMatchObject({ code: "POLICY_DENIED", details: { field: "approvalPolicy" } });
  });
});
