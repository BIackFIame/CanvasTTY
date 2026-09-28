import type { TerminalDataEvent } from "./contracts.ts";

type Listener = (event: TerminalDataEvent) => void;

/**
 * Routes terminal output to the card it belongs to. The preload receives each
 * output message once; handing every event to every card's listener made
 * the renderer cross the context bridge once per card for every batch (24 cards
 * printing a spinner: about 7 000 crossings a second, 23 of every 24 thrown away
 * by the card's own id check). A listener registered for an id gets only that
 * session's events; one registered without an id still gets all of them.
 */
export class TerminalDataRouter {
  private readonly everyone = new Set<Listener>();
  private readonly byId = new Map<string, Set<Listener>>();

  subscribe(listener: Listener, id?: string): () => void {
    if (id === undefined) {
      this.everyone.add(listener);
      return () => { this.everyone.delete(listener); };
    }
    let listeners = this.byId.get(id);
    if (!listeners) this.byId.set(id, listeners = new Set());
    listeners.add(listener);
    return () => {
      const current = this.byId.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.byId.delete(id);
    };
  }

  dispatch(event: TerminalDataEvent): void {
    for (const listener of this.everyone) listener(event);
    const listeners = this.byId.get(event.id);
    if (listeners) for (const listener of listeners) listener(event);
  }
}
