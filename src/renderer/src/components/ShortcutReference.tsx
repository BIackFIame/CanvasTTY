import type { LocaleId, ShortcutBindings } from "../../../shared/contracts";
import { t, type TranslationKey } from "../lib/i18n";

export function ShortcutReference({ locale, bindings }: { locale: LocaleId; bindings: ShortcutBindings }): React.JSX.Element {
  const mac = window.canvasTTY.window.isMacOS;
  const display = (binding: string) => binding.replace("Meta", mac ? "Command" : "Super") || t(locale, "disabled");
  const shortcuts: [string, TranslationKey][] = [
    [display(bindings.commandPalette), "commandPalette"],
    [display(bindings.openSettings), "settings"],
    [[bindings.focusUp, bindings.focusDown, bindings.focusLeft, bindings.focusRight].map(display).join(" / "), "focusWindowHint"],
    ["Shift + drag", "marqueeSelectionHint"],
    [display(bindings.terminalSearch), "terminalSearch"],
    [display(bindings.terminalCopy), "shortcutCopySelection"],
    [display(bindings.terminalPaste), "shortcutPaste"],
    [display(bindings.codexSubmit), "keyboardSubmit"],
    [display(bindings.codexNewline), "shortcutLineBreak"],
    [display(bindings.codexSelectAll), "keyboardSelectAll"],
    [[bindings.terminalPageUp, bindings.terminalPageDown].map(display).join(" / "), "shortcutScrollPages"],
    [display(bindings.terminalRestart), "shortcutRestartExited"],
    ["Enter / Shift+Enter", "shortcutSearchMatches"],
    ["↑↓ / Enter", "shortcutPaletteNavigation"],
    ["↑↓←→ / Enter / Space", "shortcutRadialNavigation"],
    ["↑↓←→", "shortcutMinimapNavigation"],
    ["Enter / Escape", "shortcutRenameConfirm"],
    ["Escape", "shortcutDismiss"]
  ];
  return (
    <dl className="shortcut-reference">
      {shortcuts.map(([keys, label]) => (
        <div key={label}><dt><kbd>{keys}</kbd></dt><dd>{t(locale, label)}</dd></div>
      ))}
    </dl>
  );
}
