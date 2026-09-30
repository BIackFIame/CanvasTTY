import type {
  CanvasNavigationMouseButton,
  CanvasWheelCaptureMode,
  ZoomSensitivity
} from "./contracts.ts";

export type CanvasNavigationPlatform = "darwin" | "other";

export interface CanvasNavigationKeyState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  pressedKeys?: ReadonlySet<string>;
  pressedMouseButtons?: ReadonlySet<CanvasNavigationMouseButton>;
}

export interface CanvasWheelOwnershipInput {
  overFocusedWidget: boolean;
  captureMode: CanvasWheelCaptureMode;
  wheelOverrideActive: boolean;
  navigationOverrideActive: boolean;
  forceCanvas?: boolean;
}

export interface ParsedCanvasNavigationBinding {
  modifiers: readonly CanvasNavigationModifier[];
  key: string | null;
}

export type CanvasNavigationModifier = "Ctrl" | "Alt" | "Shift" | "Meta";

export interface CanvasWheelDeltas {
  deltaX: number;
  deltaY: number;
}

export type CanvasWheelIntent =
  | { kind: "pan"; deltaX: number; deltaY: number }
  | { kind: "zoom"; factor: number; source: "modifier" | "wheel" };

export interface CanvasWheelIntentSettings {
  invertCanvasWheel: boolean;
  useScrollWheelToZoom: boolean;
  zoomSensitivity: ZoomSensitivity;
}

const MODIFIER_ORDER: readonly CanvasNavigationModifier[] = ["Ctrl", "Alt", "Shift", "Meta"];
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);
const LINE_DELTA_PIXELS = 16;
const MIN_MODIFIER_ZOOM_FACTOR = 0.75;
const MAX_MODIFIER_ZOOM_FACTOR = 1.25;
const WHEEL_ZOOM_BASE = 0.0012;
export const ZOOM_SENSITIVITY_FACTORS: Record<ZoomSensitivity, number> = {
  slow: 0.5,
  normal: 1,
  fast: 2
};
const NAMED_KEYS = new Set([
  "Home", "End", "PageUp", "PageDown", "Space", "Enter", "Escape", "Tab",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Insert", "Backspace"
]);
const CANVAS_NAVIGATION_MOUSE_BUTTONS = new Set<CanvasNavigationMouseButton>([
  "Mouse3", "Mouse4", "Mouse5"
]);

export function canvasNavigationPlatform(platform: string): CanvasNavigationPlatform {
  return platform === "darwin" ? "darwin" : "other";
}

export function defaultCanvasWheelBinding(platform: CanvasNavigationPlatform): "Meta" | "Ctrl" {
  return platform === "darwin" ? "Meta" : "Ctrl";
}

export function activeCanvasWheelBinding(
  mode: CanvasWheelCaptureMode,
  binding: string | null
): string | null {
  return mode === "key" ? binding : null;
}

export function parseCanvasNavigationBinding(value: unknown): ParsedCanvasNavigationBinding | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const parts = value.split("+");
  if (parts.some((part) => part.length === 0) || new Set(parts).size !== parts.length) return null;

  const modifiers: CanvasNavigationModifier[] = [];
  let key: string | null = null;
  for (const [index, part] of parts.entries()) {
    if (isCanvasNavigationModifier(part)) {
      if (key !== null) return null;
      modifiers.push(part);
      continue;
    }
    if (index !== parts.length - 1 || key !== null) return null;
    key = normalizeCanvasNavigationKey(part);
    if (!key) return null;
  }
  if (modifiers.length === 0 && (key === null || !isCanvasNavigationMouseButton(key))) return null;

  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)),
    key
  };
}

export function normalizeCanvasOverrideBinding(
  value: unknown,
  actionShortcuts: readonly string[] = []
): string | null {
  const parsed = parseCanvasNavigationBinding(value);
  if (!parsed) return null;
  const canonical = formatCanvasNavigationBinding(parsed);
  return actionShortcuts.some((shortcut) => canvasOverrideBindingConflicts(canonical, shortcut))
    ? null
    : canonical;
}

export function formatCanvasNavigationBinding(binding: ParsedCanvasNavigationBinding): string {
  return [...binding.modifiers, binding.key].filter((part): part is string => part !== null).join("+");
}

export function isCanvasNavigationBindingActive(
  state: CanvasNavigationKeyState,
  binding: string | null
): boolean {
  if (binding === null) return false;
  const parsed = parseCanvasNavigationBinding(binding);
  if (!parsed) return false;
  if (parsed.modifiers.some((modifier) => !isCanvasNavigationModifierActive(state, modifier))) return false;
  if (parsed.key === null) return true;
  if (isCanvasNavigationMouseButton(parsed.key)) {
    return state.pressedMouseButtons?.has(parsed.key) === true;
  }
  return state.pressedKeys?.has(parsed.key) === true;
}

export function isCanvasNavigationBindingKey(key: string, binding: string | null): boolean {
  if (binding === null) return false;
  const parsed = parseCanvasNavigationBinding(binding);
  if (!parsed) return false;
  const modifier = canvasNavigationModifierFromKey(key);
  if (modifier) return parsed.modifiers.includes(modifier);
  if (parsed.key !== null && isCanvasNavigationMouseButton(parsed.key)) return false;
  return parsed.key === normalizeCanvasNavigationKey(key);
}

export function isCanvasNavigationBindingMouseButton(
  button: CanvasNavigationMouseButton,
  binding: string | null
): boolean {
  if (binding === null) return false;
  const parsed = parseCanvasNavigationBinding(binding);
  return parsed?.key === button;
}

export function canvasNavigationMouseButtonFromDomButton(
  button: number
): CanvasNavigationMouseButton | null {
  if (button === 1) return "Mouse3";
  if (button === 3) return "Mouse4";
  if (button === 4) return "Mouse5";
  return null;
}

export function canvasNavigationMouseButtonFromElectronButton(
  button: string | undefined
): CanvasNavigationMouseButton | null {
  if (button === "middle") return "Mouse3";
  if (button === "back") return "Mouse4";
  if (button === "forward") return "Mouse5";
  return null;
}

export function isCanvasNavigationMouseButton(value: string): value is CanvasNavigationMouseButton {
  return CANVAS_NAVIGATION_MOUSE_BUTTONS.has(value as CanvasNavigationMouseButton);
}

export function normalizeCanvasNavigationInputKey(key: string, code?: string): string | null {
  if (typeof code === "string") {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1];
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) return digit[1];
    const codedKey = normalizeCanvasNavigationKey(code);
    if (codedKey) return codedKey;
  }
  return normalizeCanvasNavigationKey(key);
}

export function canvasOverrideBindingConflicts(binding: string, shortcut: string): boolean {
  const parsedBinding = parseCanvasNavigationBinding(binding);
  const parsedShortcut = parseShortcut(shortcut);
  if (!parsedBinding || !parsedShortcut) return false;
  if (parsedBinding.key === null) return false;
  if (parsedBinding.modifiers.some((modifier) => !parsedShortcut.modifiers.includes(modifier))) return false;
  return parsedBinding.key === parsedShortcut.key;
}

export function normalizeCanvasWheelDeltas(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  viewport: { width: number; height: number }
): CanvasWheelDeltas {
  const safeX = Number.isFinite(deltaX) ? deltaX : 0;
  const safeY = Number.isFinite(deltaY) ? deltaY : 0;
  if (deltaMode === 1) {
    return { deltaX: safeX * LINE_DELTA_PIXELS, deltaY: safeY * LINE_DELTA_PIXELS };
  }
  if (deltaMode === 2) {
    return {
      deltaX: safeX * Math.max(0, viewport.width),
      deltaY: safeY * Math.max(0, viewport.height)
    };
  }
  return { deltaX: safeX, deltaY: safeY };
}

export function canvasWheelIntent(
  deltas: CanvasWheelDeltas,
  modifiers: { ctrlKey: boolean; metaKey: boolean },
  settings: CanvasWheelIntentSettings
): CanvasWheelIntent {
  if (modifiers.ctrlKey || modifiers.metaKey) {
    return {
      kind: "zoom",
      factor: clamp(Math.exp(-deltas.deltaY / 100), MIN_MODIFIER_ZOOM_FACTOR, MAX_MODIFIER_ZOOM_FACTOR),
      source: "modifier"
    };
  }
  if (settings.useScrollWheelToZoom) {
    const deltaY = settings.invertCanvasWheel ? -deltas.deltaY : deltas.deltaY;
    return {
      kind: "zoom",
      factor: wheelZoomFactor(deltaY, settings.zoomSensitivity),
      source: "wheel"
    };
  }
  const multiplier = settings.invertCanvasWheel ? -1 : 1;
  return {
    kind: "pan",
    deltaX: deltas.deltaX * multiplier,
    deltaY: deltas.deltaY * multiplier
  };
}

export function shouldCanvasOwnWheel(input: CanvasWheelOwnershipInput): boolean {
  return input.forceCanvas === true
    || !input.overFocusedWidget
    || input.navigationOverrideActive
    || input.captureMode === "always"
    || (input.captureMode === "key" && input.wheelOverrideActive);
}

export function wheelZoomFactor(deltaY: number, sensitivity: ZoomSensitivity): number {
  return Math.exp(-deltaY * WHEEL_ZOOM_BASE * ZOOM_SENSITIVITY_FACTORS[sensitivity]);
}

export function canvasNavigationModifierFromKey(key: string): CanvasNavigationModifier | null {
  if (key === "Control" || key === "Ctrl") return "Ctrl";
  if (key === "Alt") return "Alt";
  if (key === "Shift") return "Shift";
  if (key === "Meta") return "Meta";
  return null;
}

export function activeCanvasNavigationModifiers(
  state: Pick<CanvasNavigationKeyState, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
): CanvasNavigationModifier[] {
  return MODIFIER_ORDER.filter((modifier) => isCanvasNavigationModifierActive(state, modifier));
}

export function isCanvasNavigationModifierActive(
  state: Pick<CanvasNavigationKeyState, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  modifier: CanvasNavigationModifier
): boolean {
  if (modifier === "Ctrl") return state.ctrlKey;
  if (modifier === "Alt") return state.altKey;
  if (modifier === "Shift") return state.shiftKey;
  return state.metaKey;
}

function normalizeCanvasNavigationKey(key: string): string | null {
  if (isCanvasNavigationMouseButton(key)) return key;
  if (key === " ") return "Space";
  if (key.length === 1 && /[A-Za-z0-9]/.test(key)) return key.toUpperCase();
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return key;
  return NAMED_KEYS.has(key) ? key : null;
}

function parseShortcut(shortcut: string): { modifiers: readonly CanvasNavigationModifier[]; key: string } | null {
  const parts = shortcut.split("+");
  const key = normalizeCanvasNavigationKey(parts.at(-1) ?? "");
  if (!key) return null;
  const modifiers: CanvasNavigationModifier[] = [];
  for (const modifier of parts.slice(0, -1)) {
    if (!isCanvasNavigationModifier(modifier)) return null;
    modifiers.push(modifier);
  }
  return { modifiers, key };
}

function isCanvasNavigationModifier(value: string): value is CanvasNavigationModifier {
  return MODIFIER_SET.has(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
