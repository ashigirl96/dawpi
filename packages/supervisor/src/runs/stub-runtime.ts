import { randomBytes } from "node:crypto";
import type { DelegateInput, Run, RunResult } from "@dawpi/contracts";

export type CodexRuntime = { start(run: Run, input: DelegateInput): Promise<RunResult> };

export const STUB_SUMMARY = "Codex stub: no Codex ran; this fixed result stands in for one.";

export function stubRuntime(options: { delayMs?: number } = {}): CodexRuntime {
  return {
    async start(run) {
      if (options.delayMs) await Bun.sleep(options.delayMs);
      return {
        resultId: `res_${randomBytes(8).toString("hex")}`,
        runId: run.id,
        outcome: "succeeded",
        summary: STUB_SUMMARY,
        artifacts: [],
        checks: [],
        childResults: [],
        hasUnresolvedIssues: false,
      };
    },
  };
}
