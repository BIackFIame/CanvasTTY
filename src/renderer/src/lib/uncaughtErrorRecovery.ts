import type { LocaleId } from "../../../shared/contracts";
import { t } from "./i18n";

// An error thrown while React renders, and not caught by a component, unmounts the whole root: the renderer
// process stays alive, so the main process's render-process-gone recovery never runs, and the window stays
// black until the app is restarted. The root reports such errors here. The first one reloads the
// application surface in place (sessions live in the main process and survive it, as after a renderer
// crash). A second one within the cooldown would only loop, so it gets a static page with a Reload button.

export const UNCAUGHT_ERROR_RELOAD_KEY = "canvastty.uncaughtErrorReloadAt";
export const UNCAUGHT_ERROR_RELOAD_COOLDOWN_MS = 30_000;

export interface UncaughtErrorRecoveryHost {
  now(): number;
  readLastReloadAt(): number | null;
  /** False when the reload time cannot be remembered: reloading then could loop forever. */
  writeLastReloadAt(at: number): boolean;
  reload(): void;
  showRecoveryPage(): void;
}

export type UncaughtErrorRecovery = "reload" | "recovery-page";

export function recoverFromUncaughtError(host: UncaughtErrorRecoveryHost): UncaughtErrorRecovery {
  const now = host.now();
  const last = host.readLastReloadAt();
  if (last !== null && now >= last && now - last < UNCAUGHT_ERROR_RELOAD_COOLDOWN_MS) {
    host.showRecoveryPage();
    return "recovery-page";
  }
  if (!host.writeLastReloadAt(now)) {
    host.showRecoveryPage();
    return "recovery-page";
  }
  host.reload();
  return "reload";
}

function recoveryLocale(): LocaleId {
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** Plain DOM, no React: the React root is what just failed. */
function showRecoveryPage(container: HTMLElement): void {
  const locale = recoveryLocale();
  const page = document.createElement("div");
  page.className = "renderer-recovery";
  page.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = t(locale, "rendererRecoveryTitle");
  const text = document.createElement("p");
  text.textContent = t(locale, "rendererRecoveryText");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t(locale, "rendererRecoveryReload");
  button.addEventListener("click", () => window.location.reload());
  page.append(title, text, button);
  container.replaceChildren(page);
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function handleUncaughtRenderError(container: HTMLElement, error: unknown, componentStack?: string): void {
  console.error("CanvasTTY hit an uncaught render error; recovering the application surface.", error, componentStack ?? "");
  const storage = sessionStore();
  recoverFromUncaughtError({
    now: () => Date.now(),
    readLastReloadAt: () => {
      try {
        const value = Number(storage?.getItem(UNCAUGHT_ERROR_RELOAD_KEY) ?? Number.NaN);
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
    writeLastReloadAt: (at) => {
      try {
        storage?.setItem(UNCAUGHT_ERROR_RELOAD_KEY, String(at));
        return storage?.getItem(UNCAUGHT_ERROR_RELOAD_KEY) === String(at);
      } catch {
        return false;
      }
    },
    reload: () => window.location.reload(),
    showRecoveryPage: () => showRecoveryPage(container)
  });
}
