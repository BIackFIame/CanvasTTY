import { createRequire } from "node:module";
import type { App, BrowserWindow } from "electron";

// Static CJS/HTML assets are copied by electron.vite.config.ts into out/main.
// Keeping these relative to the bundle works in dev and inside app.asar.
const require = createRequire(import.meta.url);

export function configureCanvasLinkStartup(app: App): void {
  if (!process.argv.includes("--canvaslink-high-density")) return;
  const { configureRenderScale } = require("./canvaslink/host/display-scale.cjs");
  configureRenderScale(app);
}

export function installCanvasLink(getWindow: () => BrowserWindow | null): void {
  const { install } = require("./canvaslink/host/embedded.cjs");
  // Registers the owning-frame-only settings IPC. No listener, capture or
  // discovery starts until the user explicitly enables CanvasLink in Settings.
  install({ getWindow });
}
