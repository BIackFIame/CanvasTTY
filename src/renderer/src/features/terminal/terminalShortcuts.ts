import { matchesPhysicalOrLayoutKey, matchesShortcut } from "../../lib/shortcuts.ts";

interface TerminalKeyEvent {
  type: string;
  key: string;
  code: string;
  repeat?: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
export const CODEX_SELECT_ALL_SEQUENCE = "\u001b[97;9u";

export function macCodexEnterSequence(event: TerminalKeyEvent, isMacOS: boolean, provider: string): string | null {
  if (!isMacOS || provider !== "codex" || event.type !== "keydown"
    || !(event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")
    || event.ctrlKey || event.altKey || (event.metaKey && event.shiftKey)) return null;
  if (event.metaKey) return "\u001b[13;9u";
  return event.shiftKey ? SHIFT_ENTER_SEQUENCE : "\r";
}

export function shouldSelectCodexDraft(event: TerminalKeyEvent, isMacOS: boolean, provider: string): boolean {
  return isMacOS && provider === "codex"
    && event.type === "keydown"
    && event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && matchesPhysicalOrLayoutKey(event, "KeyA", "a");
}

export function isMacTerminalClipboardShortcut(event: TerminalKeyEvent): boolean {
  return event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && (matchesPhysicalOrLayoutKey(event, "KeyC", "c")
      || matchesPhysicalOrLayoutKey(event, "KeyV", "v"));
}

export function shouldTogglePixelSkinMasterView(
  event: TerminalKeyEvent,
  selectedTerminalExists: boolean,
  reservedShortcuts: readonly string[]
): boolean {
  return selectedTerminalExists
    && event.type === "keydown"
    && !event.repeat
    && (event.key === "F4" || event.code === "F4")
    && !event.ctrlKey
    && !event.shiftKey
    && !event.metaKey
    && !event.altKey
    && !reservedShortcuts.some((shortcut) => matchesShortcut(event, shortcut));
}

export function shouldSendTerminalLineBreak(event: TerminalKeyEvent): boolean {
  return event.type === "keydown"
    && (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")
    && event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey;
}

export function shouldCopyTerminalSelection(event: TerminalKeyEvent, hasSelection: boolean): boolean {
  if (event.type !== "keydown" || !hasSelection || event.altKey) return false;

  if (!matchesPhysicalOrLayoutKey(event, "KeyC", "c")) return false;

  return (event.ctrlKey && !event.metaKey)
    || (event.metaKey && !event.ctrlKey && !event.shiftKey);
}

export function shouldPasteTerminalClipboard(event: TerminalKeyEvent): boolean {
  if (event.type !== "keydown" || event.altKey) return false;

  if (event.code === "Insert" || event.key === "Insert") {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (!matchesPhysicalOrLayoutKey(event, "KeyV", "v")) return false;

  return (event.ctrlKey && event.shiftKey && !event.metaKey)
    || (event.metaKey && !event.ctrlKey && !event.shiftKey);
}

export function shouldScrollTerminalPage(event: TerminalKeyEvent): -1 | 0 | 1 {
  if (event.type !== "keydown") return 0;
  if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return 0;
  if (event.key === "PageUp" || event.code === "PageUp") return -1;
  if (event.key === "PageDown" || event.code === "PageDown") return 1;
  return 0;
}

export function shouldRestartExitedTerminal(event: TerminalKeyEvent, exited: boolean): boolean {
  return exited
    && event.type === "keydown"
    && matchesPhysicalOrLayoutKey(event, "KeyD", "d")
    && event.ctrlKey
    && !event.shiftKey
    && !event.metaKey
    && !event.altKey;
}

export function shouldSearchTerminalOutput(event: TerminalKeyEvent): boolean {
  return event.type === "keydown"
    && matchesPhysicalOrLayoutKey(event, "KeyF", "f")
    && event.ctrlKey
    && event.shiftKey
    && !event.metaKey
    && !event.altKey;
}
