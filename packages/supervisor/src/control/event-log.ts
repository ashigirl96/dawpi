import type { ControlEvent } from "@dawpi/contracts";

export type EventPage = { cursor: number; events: ControlEvent[]; more: boolean };

type Draft = ControlEvent extends infer E
  ? E extends ControlEvent
    ? Omit<E, "seq" | "observedAt" | "schemaVersion">
    : never
  : never;

export class EventLog {
  private readonly entries: { event: ControlEvent; json: string }[] = [];
  private waiters = new Set<() => void>();

  get cursor(): number {
    return this.entries.length;
  }

  append(draft: Draft): ControlEvent {
    const event = {
      schemaVersion: 1,
      seq: this.entries.length + 1,
      observedAt: new Date().toISOString(),
      ...draft,
    } as ControlEvent;
    this.entries.push({ event, json: JSON.stringify(event) });
    const woken = this.waiters;
    this.waiters = new Set();
    for (const wake of woken) wake();
    return event;
  }

  async wait(after: number, waitMs: number): Promise<void> {
    if (this.cursor > after || waitMs <= 0) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      this.waiters.add(wake);
    });
  }

  page(after: number, maxBytes: number): EventPage {
    const events: ControlEvent[] = [];
    let bytes = 0;
    let cursor = after;
    for (const { event, json } of this.entries.slice(after)) {
      const size = Buffer.byteLength(json) + 1;
      if (bytes + size > maxBytes) {
        if (events.length > 0) return { cursor, events, more: true };
        events.push(omitted(event, size));
        return { cursor: event.seq, events, more: this.cursor > event.seq };
      }
      bytes += size;
      events.push(event);
      cursor = event.seq;
    }
    return { cursor, events, more: false };
  }
}

function omitted(event: ControlEvent, bytes: number): ControlEvent {
  return { ...event, kind: "event.omitted", payload: { kind: event.kind, bytes } };
}
