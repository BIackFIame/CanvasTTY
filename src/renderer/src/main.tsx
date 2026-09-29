import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminalSkins.css";
import "./styles/ornateTerminalSkins.css";
import "./styles/pixelTerminalSkins.css";
import "./styles/pixelSkinPackCreator.css";
import "./styles/appSkins.css";
import "./styles/patterns.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
