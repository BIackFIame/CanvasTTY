import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { handleUncaughtRenderError } from "./lib/uncaughtErrorRecovery";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminalSkins.css";
import "./styles/ornateTerminalSkins.css";
import "./styles/pixelTerminalSkins.css";
import "./styles/pixelSkinPackCreator.css";
import "./styles/appSkins.css";
import "./styles/patterns.css";

const container = document.getElementById("root")!;
createRoot(container, {
  // React unmounts the whole tree on an uncaught render error while the renderer process lives on:
  // without this the window stays black and the main process has no crash to recover from.
  onUncaughtError: (error, errorInfo) => handleUncaughtRenderError(container, error, errorInfo.componentStack)
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
