import { lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { createCommands } from "./commands.ts";
import { EventLog } from "./control/event-log.ts";
import { createGuardFiles, HANDBACK_DECISIONS, type HandbackDecision } from "./host/guard-files.ts";
import { serveControl } from "./control/server.ts";
import { createRunBook } from "./runs/run-book.ts";
import {
  assertSessionId,
  prepareSessionDir,
  prepareSocket,
  removeStaleSessionDirs,
  touch,
} from "./lifecycle/directories.ts";
import { watchParent } from "./lifecycle/parent-watch.ts";

const PARENT_POLL_MS = 1_000;
const EXPIRY_SWEEP_MS = 1_000;
const SESSION_TOUCH_MS = 6 * 60 * 60 * 1000;

const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      socket: { type: "string" },
      home: { type: "string", default: join(homedir(), ".codex-bridge") },
      "handback-decision": { type: "string", default: "none" },
    },
  });
  if (!values.session || !values.socket) {
    throw new Error("usage: main.ts --session <id> --socket <path> [--home <dir>] [--handback-decision allow|none]");
  }
  const handbackDecision = values["handback-decision"] as HandbackDecision;
  if (!HANDBACK_DECISIONS.includes(handbackDecision)) throw new Error("--handback-decision must be allow or none");
  const sessionId = values.session;
  const socketPath = values.socket;
  assertSessionId(sessionId);

  const sessionDir = prepareSessionDir(values.home, sessionId);
  const guard = createGuardFiles(sessionDir, { handbackDecision });
  const removedSessions = removeStaleSessionDirs(values.home, sessionId);
  prepareSocket(socketPath);

  const log = new EventLog();
  const info = {
    version: pkg.version,
    pid: process.pid,
    sessionId,
    sessionDir,
    socketPath,
    startedAt: new Date().toISOString(),
  };
  const runs = createRunBook({ log, guard });
  serveControl({ socketPath, log, command: createCommands(info, log, guard, runs) });
  const socketIno = lstatSync(socketPath).ino;
  log.append({ origin: "supervisor", kind: "supervisor.started", payload: { version: info.version, pid: info.pid } });

  // A newer Supervisor of the same session may already own the path after a reload, so unlink only our own inode; server.stop() would unlink the path unconditionally.
  const releaseSocket = () => {
    try {
      if (lstatSync(socketPath).ino === socketIno) unlinkSync(socketPath);
    } catch {}
  };
  const exit = (reason: string) => {
    releaseSocket();
    // stdout's reader is usually the parent that just went away.
    try {
      say({ kind: "exit", reason });
    } catch {}
    process.exit(0);
  };
  watchParent(PARENT_POLL_MS, () => exit("parent-gone"));
  setInterval(() => touch(sessionDir), SESSION_TOUCH_MS);
  setInterval(() => runs.expireOverdue(), EXPIRY_SWEEP_MS);
  // The Supervisor shares Claude Code's process group, so closing its terminal sends SIGHUP here too.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => exit(signal));

  say({ kind: "ready", version: info.version, pid: info.pid, socket: socketPath, sessionDir, removedSessions });
}

try {
  main();
} catch (err) {
  say({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
