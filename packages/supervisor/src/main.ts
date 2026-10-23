import { lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { createCommands } from "./commands.ts";
import { EventLog } from "./control/event-log.ts";
import { serveControl } from "./control/server.ts";
import {
  assertSessionId,
  prepareSessionDir,
  prepareSocket,
  removeStaleSessionDirs,
  touch,
} from "./lifecycle/directories.ts";
import { watchParent } from "./lifecycle/parent-watch.ts";

const PARENT_POLL_MS = 1_000;
const SESSION_TOUCH_MS = 6 * 60 * 60 * 1000;

const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      socket: { type: "string" },
      home: { type: "string", default: join(homedir(), ".codex-bridge") },
    },
  });
  if (!values.session || !values.socket) throw new Error("usage: main.ts --session <id> --socket <path> [--home <dir>]");
  const sessionId = values.session;
  const socketPath = values.socket;
  assertSessionId(sessionId);

  const sessionDir = prepareSessionDir(values.home, sessionId);
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
  serveControl({ socketPath, log, command: createCommands(info, log) });
  const socketIno = lstatSync(socketPath).ino;
  log.append({ origin: "supervisor", kind: "supervisor.started", payload: { version: info.version, pid: info.pid } });

  // A newer Supervisor of the same session may already own the path after a reload, so unlink only our own inode; server.stop() would unlink the path unconditionally.
  const releaseSocket = () => {
    try {
      if (lstatSync(socketPath).ino === socketIno) unlinkSync(socketPath);
    } catch {}
  };
  const exit = (reason: string, code: number) => {
    say({ kind: "exit", reason });
    releaseSocket();
    process.exit(code);
  };
  watchParent(PARENT_POLL_MS, () => exit("parent-gone", 0));
  setInterval(() => touch(sessionDir), SESSION_TOUCH_MS);
  process.on("SIGTERM", () => exit("SIGTERM", 0));
  process.on("SIGINT", () => exit("SIGINT", 0));

  say({ kind: "ready", version: info.version, pid: info.pid, socket: socketPath, sessionDir, removedSessions });
}

try {
  main();
} catch (err) {
  say({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
