import { IPC, type TerminalDataEvent } from "../../shared/contracts.ts";

/**
 * The renderer end of the terminal event stream. TerminalManager flushes every
 * session's output batch in the same task; the outbox collects the renderer's
 * share of that flush and sends it as one terminalDataBatch message at the end
 * of the task, instead of one IPC message per session per batch. Session and
 * removal events go out at once, after whatever output is still collected, so
 * the renderer sees every event in the order the manager emitted it.
 */
export class TerminalRendererOutbox {
  private pending: TerminalDataEvent[] = [];
  private scheduled = false;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly schedule: (task: () => void) => void;

  constructor(send: (channel: string, payload: unknown) => void, schedule: (task: () => void) => void = queueMicrotask) {
    this.send = send;
    this.schedule = schedule;
  }

  push(channel: string, payload: unknown): void {
    if (channel === IPC.terminalData) {
      this.pending.push(payload as TerminalDataEvent);
      if (!this.scheduled) {
        this.scheduled = true;
        this.schedule(() => this.flush());
      }
      return;
    }
    this.flush();
    this.send(channel, payload);
  }

  flush(): void {
    this.scheduled = false;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.send(IPC.terminalDataBatch, batch);
  }
}
