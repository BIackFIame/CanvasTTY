/** The bundled ConPTY 1.23 emits modern wrap markers, independently of the Windows build. */
export function terminalEmulatorOptions(platform: string): { windowsPty?: { backend: "conpty" } } {
  return platform === "win32" ? { windowsPty: { backend: "conpty" } } : {};
}

export function terminalPtyOptions(platform: string): { useConpty?: boolean; useConptyDll?: boolean } {
  return platform === "win32" ? { useConpty: true, useConptyDll: true } : {};
}

/** ConPTY 1.22+ queries DA1 during startup; xterm's default VT100 reply is insufficient. */
export const CONPTY_DEVICE_ATTRIBUTES = "\x1b[?61;4c";
