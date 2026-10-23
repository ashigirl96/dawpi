import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupAll, firstLine, onCleanup, shortSocketPath, start, tempHome } from "./harness.ts";

afterEach(cleanupAll);

const MAIN = join(import.meta.dir, "../src/main.ts");
const DAY_MS = 24 * 60 * 60 * 1000;

function age(path: string, ms: number) {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) return false;
    await Bun.sleep(50);
  }
  return true;
}

describe("parent process", () => {
  test("the Supervisor exits when its parent is killed", async () => {
    const home = tempHome();
    const socketPath = shortSocketPath();
    const parent = Bun.spawn(
      ["sh", "-c", 'bun "$0" --session sess-p --socket "$1" --home "$2"; :', MAIN, socketPath, home],
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    const { pid } = JSON.parse(await firstLine(parent.stdout));
    onCleanup(() => alive(pid) && process.kill(pid, "SIGKILL"));
    expect(alive(pid)).toBe(true);

    parent.kill("SIGKILL");
    expect(await until(() => !alive(pid), 3000)).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
  });

  test.each(["SIGTERM", "SIGHUP"] as const)("%s stops it and removes its socket", async (signal) => {
    const s = await start();
    s.proc.kill(signal);
    expect(await s.proc.exited).toBe(0);
    expect(existsSync(s.socketPath)).toBe(false);
  });
});

describe("state directories", () => {
  test("creates its session directory and the socket directory with mode 700", async () => {
    const s = await start({ sessionId: "sess-own" });
    const sessionDir = join(s.home, "sessions", "sess-own");
    expect(s.ready.sessionDir).toBe(sessionDir);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.home, "sessions")).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(s.socketPath)).mode & 0o777).toBe(0o700);
  });

  test("removes other sessions' directories past the retention period and keeps the rest", async () => {
    const home = tempHome();
    const sessions = join(home, "sessions");
    for (const id of ["old", "recent", "old-but-active", "sess-own"]) mkdirSync(join(sessions, id), { recursive: true });
    age(join(sessions, "old"), 8 * DAY_MS);
    age(join(sessions, "recent"), 1 * DAY_MS);
    mkdirSync(join(sessions, "old-but-active", "roster"));
    age(join(sessions, "old-but-active"), 8 * DAY_MS);
    writeFileSync(join(sessions, "sess-own", "marker"), "");
    age(join(sessions, "sess-own"), 30 * DAY_MS);

    const s = await start({ home, sessionId: "sess-own" });
    expect(s.ready.removedSessions).toEqual(["old"]);
    expect(existsSync(join(sessions, "old"))).toBe(false);
    expect(existsSync(join(sessions, "recent"))).toBe(true);
    expect(existsSync(join(sessions, "old-but-active"))).toBe(true);
    expect(existsSync(join(sessions, "sess-own", "marker"))).toBe(true);
  });

  test("replaces a stale socket left at its path", async () => {
    const first = await start();
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    expect(existsSync(first.socketPath)).toBe(true);

    const second = await start({ socketPath: first.socketPath });
    expect((await second.command({ op: "status" })).json.value.pid).toBe(second.proc.pid);
  });

  test("a stopping Supervisor leaves a newer Supervisor's socket at the same path", async () => {
    const older = await start();
    const newer = await start({ socketPath: older.socketPath });
    older.proc.kill("SIGTERM");
    await older.proc.exited;
    expect((await newer.command({ op: "status" })).json.value.pid).toBe(newer.proc.pid);
  });

  test("refuses a socket path longer than the platform allows", async () => {
    const s = await start({ socketPath: `/tmp/${"x".repeat(100)}.sock` });
    expect(s.ready).toMatchObject({ kind: "error" });
    expect(await s.proc.exited).toBe(1);
  });
});
