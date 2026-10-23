import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../lifecycle/directories.ts";

// guard.sh builds file paths from these ids, so they must not carry path separators.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HANDBACK = "SubagentHandback";

export type HandbackDecision = "allow" | "none";
export const HANDBACK_DECISIONS: readonly HandbackDecision[] = ["allow", "none"];

export type PermitRequest = { agentId: string; tool: string };

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

export function createGuardFiles(sessionDir: string, options: { handbackDecision: HandbackDecision }) {
  const roster = join(sessionDir, "roster");
  const permits = join(sessionDir, "permits");
  ensurePrivateDir(roster);
  ensurePrivateDir(permits);

  return {
    addToRoster(agentId: string): void {
      writeFileSync(join(roster, agentId), "", { mode: 0o600 });
    },
    isOnRoster(agentId: string): boolean {
      return existsSync(join(roster, agentId));
    },
    issuePermit({ agentId, tool }: PermitRequest): string {
      const toolUseId = `toolu_cb${randomBytes(12).toString("hex")}`;
      const decision = tool === HANDBACK ? options.handbackDecision : "allow";
      writeFileSync(join(permits, toolUseId), `${JSON.stringify({ agentId, tool, decision })}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return toolUseId;
    },
  };
}

export type GuardFiles = ReturnType<typeof createGuardFiles>;
