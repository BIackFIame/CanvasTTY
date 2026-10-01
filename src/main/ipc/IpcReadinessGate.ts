// The renderer loads while the main-process services are still starting, so an IPC call can arrive before the
// service behind it exists. This gate makes such a call wait instead of failing with "No handler registered":
// before the renderer loads, every channel gets a placeholder; a placeholder `invoke` waits until the channel's real
// handler is registered (each service group registers its handlers as soon as that group is ready), and a
// placeholder `send` is queued and replayed, in order, to the real listener. Once startup has registered everything,
// `settle()` removes the placeholders nobody claimed, and `fail()` rejects what is still waiting when startup fails.
//
// No electron import at runtime: the registrar is injected (ipcMain in the app, a fake in tests).
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
type SendListener = (event: IpcMainEvent, ...args: any[]) => void;

/** The part of ipcMain the gate and the handler registrations use. */
export interface IpcRegistrar {
  handle(channel: string, listener: InvokeListener): void;
  on(channel: string, listener: SendListener): unknown;
}

export interface IpcMainLike extends IpcRegistrar {
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: SendListener): unknown;
}

export interface IpcReadinessGateOptions {
  /** Every channel a renderer may use before startup registered it. */
  channels: readonly string[];
  /**
   * `sendSync` channels answered at once while their service is not up: a synchronous sender blocks its renderer
   * until it gets a reply, so queueing it would freeze the window. The value is the reply.
   */
  syncReplies?: Readonly<Record<string, unknown>>;
  /** Queued fire-and-forget messages per channel before the oldest are dropped (a bound, not an expected load). */
  maxQueuedPerChannel?: number;
}

interface Waiter {
  resolve(listener: InvokeListener): void;
  reject(error: Error): void;
}

export class IpcReadinessGate implements IpcRegistrar {
  private readonly ipc: IpcMainLike;
  private readonly syncReplies: Readonly<Record<string, unknown>>;
  private readonly maxQueued: number;
  private readonly invokeWaiters = new Map<string, Waiter[]>();
  private readonly invokePlaceholders = new Set<string>();
  private readonly sendPlaceholders = new Map<string, SendListener>();
  private readonly sendQueues = new Map<string, Array<{ event: IpcMainEvent; args: unknown[] }>>();
  private readonly unclaimed: Set<string>;
  private failure: Error | null = null;
  private settled = false;

  constructor(ipc: IpcMainLike, options: IpcReadinessGateOptions) {
    this.ipc = ipc;
    this.syncReplies = options.syncReplies ?? {};
    this.maxQueued = options.maxQueuedPerChannel ?? 1_000;
    this.unclaimed = new Set(options.channels);
    for (const channel of new Set(options.channels)) {
      this.invokePlaceholders.add(channel);
      ipc.handle(channel, (event, ...args) => this.waitAndInvoke(channel, event, args));
      const placeholder: SendListener = (event, ...args) => this.queueSend(channel, event, args);
      this.sendPlaceholders.set(channel, placeholder);
      ipc.on(channel, placeholder);
    }
  }

  /** Registers the real invoke handler; calls already waiting on the channel run it now. */
  handle(channel: string, listener: InvokeListener): void {
    this.unclaimed.delete(channel);
    if (this.invokePlaceholders.delete(channel)) this.ipc.removeHandler(channel);
    this.ipc.handle(channel, listener);
    const waiters = this.invokeWaiters.get(channel);
    this.invokeWaiters.delete(channel);
    for (const waiter of waiters ?? []) waiter.resolve(listener);
  }

  /** Registers the real listener and replays, in order, what was sent to the channel before. */
  on(channel: string, listener: SendListener): this {
    this.unclaimed.delete(channel);
    const placeholder = this.sendPlaceholders.get(channel);
    if (placeholder) {
      this.sendPlaceholders.delete(channel);
      this.ipc.removeListener(channel, placeholder);
    }
    this.ipc.on(channel, listener);
    const queued = this.sendQueues.get(channel);
    this.sendQueues.delete(channel);
    for (const message of queued ?? []) {
      try {
        listener(message.event, ...message.args);
      } catch (error) {
        console.warn(`CanvasTTY could not replay an early "${channel}" message.`, error);
      }
    }
    return this;
  }

  /** Startup failed: calls waiting now or later reject with this error, queued messages are dropped. */
  fail(error: Error): void {
    this.failure = error;
    for (const [, waiters] of this.invokeWaiters) for (const waiter of waiters) waiter.reject(error);
    this.invokeWaiters.clear();
    this.sendQueues.clear();
  }

  /**
   * Startup registered everything it will: channels still unclaimed have no handler in this build (or belong to a
   * surface that is not the main renderer). Their placeholders go away, so they fail the way Electron fails an
   * unregistered channel instead of waiting forever.
   */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    for (const channel of this.invokePlaceholders) this.ipc.removeHandler(channel);
    for (const [channel, placeholder] of this.sendPlaceholders) this.ipc.removeListener(channel, placeholder);
    const unclaimed = [...this.invokeWaiters.keys()];
    for (const channel of unclaimed) {
      for (const waiter of this.invokeWaiters.get(channel) ?? []) waiter.reject(new Error(`No handler registered for '${channel}'`));
    }
    this.invokePlaceholders.clear();
    this.sendPlaceholders.clear();
    this.invokeWaiters.clear();
    this.sendQueues.clear();
  }

  /** Channels with neither a real handler nor a real listener yet (diagnostics and tests). */
  pendingChannels(): string[] {
    return [...this.unclaimed].sort();
  }

  private waitAndInvoke(channel: string, event: IpcMainInvokeEvent, args: unknown[]): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<InvokeListener>((resolve, reject) => {
      const waiters = this.invokeWaiters.get(channel) ?? [];
      waiters.push({ resolve, reject });
      this.invokeWaiters.set(channel, waiters);
    }).then((listener) => listener(event, ...args));
  }

  private queueSend(channel: string, event: IpcMainEvent, args: unknown[]): void {
    if (Object.prototype.hasOwnProperty.call(this.syncReplies, channel)) {
      event.returnValue = this.syncReplies[channel];
      return;
    }
    if (this.failure || this.settled) return;
    const queue = this.sendQueues.get(channel) ?? [];
    queue.push({ event, args });
    if (queue.length > this.maxQueued) queue.shift();
    this.sendQueues.set(channel, queue);
  }
}
