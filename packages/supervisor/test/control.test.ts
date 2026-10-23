import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, start } from "./harness.ts";

afterEach(cleanupAll);

describe("Supervisor control socket", () => {
  test("announces readiness in one stdout line and answers status", async () => {
    const s = await start({ sessionId: "sess-a" });
    expect(s.ready).toMatchObject({ kind: "ready", socket: s.socketPath, pid: s.proc.pid });

    const { json } = await s.command({ op: "status" });
    expect(json).toMatchObject({ ok: true, value: { sessionId: "sess-a", pid: s.proc.pid } });
    expect(typeof json.value.version).toBe("string");
  });
});

describe("events long poll", () => {
  test("starts with a supervisor.started event", async () => {
    const s = await start();
    const { json } = await s.events("after=0&waitMs=0");
    expect(json.value).toMatchObject({ cursor: 1, more: false, events: [{ seq: 1, kind: "supervisor.started" }] });
  });

  test("a waiting poll returns as soon as a command adds an event", async () => {
    const s = await start();
    const t0 = Date.now();
    const polled = s.events("after=1&waitMs=10000");
    await Bun.sleep(100);
    await s.command({ op: "ping", token: "hello" });
    const { json } = await polled;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(json.value).toMatchObject({ cursor: 2, events: [{ seq: 2, kind: "ping", payload: { token: "hello" } }] });
  });

  test("a poll with nothing new returns empty after waitMs", async () => {
    const s = await start();
    const t0 = Date.now();
    const { json } = await s.events("after=1&waitMs=300");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(json.value).toEqual({ cursor: 1, events: [], more: false });
  });

  test("splits a backlog into pages of at most 256 KiB", async () => {
    const s = await start();
    const token = "x".repeat(60 * 1024);
    for (let i = 0; i < 10; i++) await s.command({ op: "ping", token });

    const seen: number[] = [];
    let after = 0;
    let more = true;
    while (more) {
      const page = await s.events(`after=${after}&waitMs=0`);
      expect(page.bytes).toBeLessThanOrEqual(256 * 1024);
      seen.push(...page.json.value.events.map((e: { seq: number }) => e.seq));
      after = page.json.value.cursor;
      more = page.json.value.more;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("refuses a cursor ahead of this Supervisor", async () => {
    const s = await start();
    const { status, json } = await s.events("after=99&waitMs=0");
    expect(status).toBe(409);
    expect(json).toMatchObject({ ok: false, error: { code: "STATE_CONFLICT", details: { cursor: 1 } } });
  });
});

describe("command errors", () => {
  test("an unknown op is UNSUPPORTED_REQUEST", async () => {
    const s = await start();
    const { json } = await s.command({ op: "fly" });
    expect(json).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_REQUEST" } });
  });

  test("a body that is not JSON is INVALID_INPUT", async () => {
    const s = await start();
    const { status, json } = await s.command("{not json");
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});
