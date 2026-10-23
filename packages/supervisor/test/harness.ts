import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");

export type Started = {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  ready: Record<string, unknown>;
  socketPath: string;
  home: string;
  command: (body: unknown) => Promise<{ status: number; json: any }>;
  events: (query: string) => Promise<{ status: number; bytes: number; json: any }>;
};

const cleanups: (() => void)[] = [];

export function onCleanup(fn: () => void) {
  cleanups.push(fn);
}

export function cleanupAll() {
  while (cleanups.length > 0) cleanups.pop()!();
}

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cbx-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

export function shortSocketPath(): string {
  const dir = `/tmp/cbt-${Math.random().toString(36).slice(2, 8)}`;
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return `${dir}/s.sock`;
}

export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return buf.split("\n")[0] ?? "";
}

export async function start(
  options: { sessionId?: string; home?: string; socketPath?: string; extraArgs?: string[] } = {},
): Promise<Started> {
  const home = options.home ?? tempHome();
  const socketPath = options.socketPath ?? shortSocketPath();
  const proc = Bun.spawn(
    [
      "bun",
      MAIN,
      "--session",
      options.sessionId ?? "sess-test",
      "--socket",
      socketPath,
      "--home",
      home,
      ...(options.extraArgs ?? []),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  cleanups.push(() => proc.kill("SIGKILL"));
  const line = await firstLine(proc.stdout);
  const ready = JSON.parse(line);
  const command = async (body: unknown) => {
    const res = await fetch("http://supervisor/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      unix: socketPath,
    });
    return { status: res.status, json: await res.json() };
  };
  const events = async (query: string) => {
    const res = await fetch(`http://supervisor/events?${query}`, { unix: socketPath });
    const text = await res.text();
    return { status: res.status, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
  };
  return { proc, ready, socketPath, home, command, events };
}
