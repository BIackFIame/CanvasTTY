export function electronSmokeLaunchBlockReason(platform, environment) {
  if (platform === "darwin" && environment.CODEX_SANDBOX === "seatbelt") {
    return "Cannot run the Electron smoke from a macOS CODEX_SANDBOX=seatbelt process. Run `npm run smoke:terminal-hidden` from a regular terminal or another GUI-capable launch; the Electron child was not started.";
  }
  return undefined;
}
