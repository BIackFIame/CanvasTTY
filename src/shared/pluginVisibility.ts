/**
 * Plugin frame visibility (surface lifecycle for plugin documents, docs/plugins.md "Visibility").
 *
 * A canvas plugin runs in a sandboxed iframe inside the app page. When nobody can see its card (summary
 * zoom, HOME editing, off-screen, minimized window) the host posts
 * `{ source: "canvastty-host", type: "visibility", state: "hidden" }` and, when it is seen again,
 * `state: "visible"`. The input bridge the host injects at the top of every plugin page turns that into
 * standard page-visibility semantics, the same ones Chromium applies to a background tab:
 *
 * - `document.visibilityState` / `document.hidden` report hidden and `visibilitychange` fires;
 * - timers (`setTimeout`, `setInterval`) wake at most once a second, aligned to whole seconds;
 * - `requestAnimationFrame` callbacks are held and run on the first frame after the document is shown.
 *
 * Nothing is torn down: the document, its DOM, JS state, network, audio and workers keep running.
 */
export type PluginVisibilityState = "visible" | "hidden";

export interface PluginVisibilityMessage {
  source: "canvastty-host";
  type: "visibility";
  state: PluginVisibilityState;
}

export function pluginVisibilityMessage(live: boolean): PluginVisibilityMessage {
  return { source: "canvastty-host", type: "visibility", state: live ? "visible" : "hidden" };
}

/** The throttled timer period while hidden, in milliseconds (Chromium's background-tab rate). */
export const PLUGIN_HIDDEN_TIMER_PERIOD_MS = 1_000;

/**
 * Statements injected into the plugin input bridge (inside its IIFE, after the top-level-window guard).
 * Plain ES2020, no dependencies: it runs before any plugin script, so the plugin's own timers and frames
 * all go through it.
 */
export const PLUGIN_VISIBILITY_BRIDGE_SOURCE = `
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const pageHidden = () => visibilityDescriptor && visibilityDescriptor.get
    ? visibilityDescriptor.get.call(document) === "hidden"
    : false;
  let hostHidden = false;
  const effectiveHidden = () => hostHidden || pageHidden();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (effectiveHidden() ? "hidden" : "visible")
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: effectiveHidden });

  const nativeTimers = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window)
  };
  const HIDDEN_PERIOD = ${PLUGIN_HIDDEN_TIMER_PERIOD_MS};
  const nextAlignedWake = () => HIDDEN_PERIOD - (Date.now() % HIDDEN_PERIOD);
  const timers = new Map();
  let nextTimerId = 1000000000;
  const armTimer = (id, timer, delay) => {
    timer.handle = nativeTimers.setTimeout(() => fireTimer(id), delay);
  };
  const fireTimer = (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    if (hostHidden && !timer.deferred) {
      timer.deferred = true;
      armTimer(id, timer, nextAlignedWake());
      return;
    }
    timer.deferred = false;
    if (timer.repeat) {
      armTimer(id, timer, hostHidden ? Math.max(timer.delay, nextAlignedWake()) : timer.delay);
      // Already on the throttled schedule: the next wake runs it instead of deferring it again.
      timer.deferred = hostHidden;
    } else {
      timers.delete(id);
    }
    timer.callback.apply(window, timer.args);
  };
  const addTimer = (repeat, callback, delay, args) => {
    const id = nextTimerId++;
    const timer = { repeat, callback, args, delay: Math.max(0, Number(delay) || 0), handle: 0, deferred: false };
    timers.set(id, timer);
    armTimer(id, timer, timer.delay);
    return id;
  };
  const clearTimer = (id) => {
    const timer = timers.get(id);
    if (!timer) return false;
    timers.delete(id);
    nativeTimers.clearTimeout(timer.handle);
    return true;
  };
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setTimeout = function setTimeout(callback, delay, ...args) {
    if (typeof callback !== "function") return nativeTimers.setTimeout(callback, delay, ...args);
    return addTimer(false, callback, delay, args);
  };
  window.setInterval = function setInterval(callback, delay, ...args) {
    if (typeof callback !== "function") return nativeSetInterval(callback, delay, ...args);
    return addTimer(true, callback, delay, args);
  };
  window.clearTimeout = function clearTimeout(id) {
    if (!clearTimer(id)) nativeTimers.clearTimeout(id);
  };
  window.clearInterval = function clearInterval(id) {
    if (!clearTimer(id)) nativeClearInterval(id);
  };

  const frames = new Map();
  let nextFrameId = 1;
  const requestFrame = (id, frame) => {
    frame.handle = nativeTimers.requestAnimationFrame((time) => runFrame(id, time));
  };
  const runFrame = (id, time) => {
    const frame = frames.get(id);
    if (!frame) return;
    if (hostHidden) {
      frame.handle = 0;
      return;
    }
    frames.delete(id);
    frame.callback.call(window, time);
  };
  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== "function") return nativeTimers.requestAnimationFrame(callback);
    const id = nextFrameId++;
    const frame = { callback, handle: 0 };
    frames.set(id, frame);
    if (!hostHidden) requestFrame(id, frame);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const frame = frames.get(id);
    if (!frame) return;
    frames.delete(id);
    if (frame.handle) nativeTimers.cancelAnimationFrame(frame.handle);
  };

  const setHostHidden = (next) => {
    if (next === hostHidden) return;
    const wasHidden = effectiveHidden();
    hostHidden = next;
    if (next) {
      for (const frame of frames.values()) {
        if (frame.handle) nativeTimers.cancelAnimationFrame(frame.handle);
        frame.handle = 0;
      }
    } else {
      for (const [id, frame] of frames) if (!frame.handle) requestFrame(id, frame);
      for (const [id, timer] of timers) {
        if (!timer.deferred && !timer.repeat) continue;
        nativeTimers.clearTimeout(timer.handle);
        const delay = timer.deferred ? 0 : timer.delay;
        timer.deferred = false;
        armTimer(id, timer, delay);
      }
    }
    if (wasHidden !== effectiveHidden()) document.dispatchEvent(new Event("visibilitychange"));
  };
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.source !== "canvastty-host") return;
    if (message.type === "visibility") setHostHidden(message.state === "hidden");
  });
`;
