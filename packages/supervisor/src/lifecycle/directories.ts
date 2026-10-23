import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";

// macOS limits sun_path to 104 bytes including the terminating NUL.
export const MAX_SOCKET_PATH_BYTES = 103;
export const SESSION_DIR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SetupError extends Error {}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new SetupError(`${path} is not a directory`);
  if (st.uid !== process.getuid!()) throw new SetupError(`${path} is owned by another user`);
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

export function prepareSocket(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new SetupError(`socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`);
  }
  ensurePrivateDir(dirname(socketPath));
  try {
    if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
    else throw new SetupError(`${socketPath} exists and is not a socket`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new SetupError("session id must match [A-Za-z0-9_-]{1,64}");
}

export function prepareSessionDir(home: string, sessionId: string): string {
  const sessions = join(home, "sessions");
  ensurePrivateDir(home);
  ensurePrivateDir(sessions);
  const own = join(sessions, sessionId);
  ensurePrivateDir(own);
  touch(own);
  return own;
}

export function removeStaleSessionDirs(home: string, ownSessionId: string, now = Date.now()): string[] {
  const sessions = join(home, "sessions");
  const removed: string[] = [];
  for (const name of readdirSync(sessions)) {
    if (name === ownSessionId) continue;
    const dir = join(sessions, name);
    const lastUsed = lastModified(dir);
    if (lastUsed === undefined || now - lastUsed < SESSION_DIR_TTL_MS) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function touch(dir: string): void {
  const now = new Date();
  utimesSync(dir, now, now);
}

// Roster and permit files land in subdirectories, so the newest child mtime is the session's last use.
function lastModified(dir: string): number | undefined {
  const st = lstatSync(dir);
  if (!st.isDirectory()) return undefined;
  let latest = st.mtimeMs;
  for (const name of readdirSync(dir)) {
    latest = Math.max(latest, statSync(join(dir, name)).mtimeMs);
  }
  return latest;
}
