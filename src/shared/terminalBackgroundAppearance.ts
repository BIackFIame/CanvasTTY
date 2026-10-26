import { isTerminalBackgroundId, type TerminalBackgroundId } from "./terminalBackground.ts";

export interface TerminalBackgroundAppearance {
  terminalBackground: TerminalBackgroundId;
  terminalBackgroundBrightness: number;
  terminalBackgroundContrast: number;
  terminalBackgroundSaturation: number;
  terminalBackgroundPaused: boolean;
  terminalBackgroundSpeed: number;
  terminalBackgroundScale: number;
  terminalBackgroundOffsetX: number;
  terminalBackgroundOffsetY: number;
  terminalBackgroundReadability: boolean;
  terminalBackgroundReadabilityStrength: number;
  terminalBackgroundPauseOnOutput: boolean;
  terminalBackgroundFocusDimming: boolean;
}

export interface TerminalBackgroundPreset {
  id: string;
  name: string;
  appearance: TerminalBackgroundAppearance;
}

export const BACKGROUND_APPEARANCE_DEFAULTS: TerminalBackgroundAppearance = {
  terminalBackground: "none", terminalBackgroundBrightness: 45,
  terminalBackgroundContrast: 100, terminalBackgroundSaturation: 100,
  terminalBackgroundPaused: false, terminalBackgroundSpeed: 1,
  terminalBackgroundScale: 100, terminalBackgroundOffsetX: 0, terminalBackgroundOffsetY: 0,
  terminalBackgroundReadability: true, terminalBackgroundReadabilityStrength: 86,
  terminalBackgroundPauseOnOutput: false,
  terminalBackgroundFocusDimming: false,
};

export function normalizeBackgroundAppearance(value: unknown): TerminalBackgroundAppearance {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: keyof TerminalBackgroundAppearance, min: number, max: number): number =>
    typeof source[key] === "number" && Number.isFinite(source[key])
      ? Math.min(max, Math.max(min, source[key] as number)) : BACKGROUND_APPEARANCE_DEFAULTS[key] as number;
  return {
    terminalBackground: isTerminalBackgroundId(source.terminalBackground) ? source.terminalBackground : "none",
    terminalBackgroundBrightness: number("terminalBackgroundBrightness", 5, 100),
    terminalBackgroundContrast: number("terminalBackgroundContrast", 0, 200),
    terminalBackgroundSaturation: number("terminalBackgroundSaturation", 0, 200),
    terminalBackgroundSpeed: number("terminalBackgroundSpeed", .25, 2),
    terminalBackgroundScale: number("terminalBackgroundScale", 25, 300),
    terminalBackgroundOffsetX: number("terminalBackgroundOffsetX", -50, 50),
    terminalBackgroundOffsetY: number("terminalBackgroundOffsetY", -50, 50),
    terminalBackgroundReadabilityStrength: number("terminalBackgroundReadabilityStrength", 0, 100),
    terminalBackgroundPaused: typeof source.terminalBackgroundPaused === "boolean" ? source.terminalBackgroundPaused : false,
    terminalBackgroundReadability: typeof source.terminalBackgroundReadability === "boolean" ? source.terminalBackgroundReadability : true,
    terminalBackgroundPauseOnOutput: typeof source.terminalBackgroundPauseOnOutput === "boolean" ? source.terminalBackgroundPauseOnOutput : false,
    terminalBackgroundFocusDimming: typeof source.terminalBackgroundFocusDimming === "boolean" ? source.terminalBackgroundFocusDimming : false,
  };
}

export function normalizeBackgroundOverrides(value: unknown): Record<string, TerminalBackgroundAppearance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, appearance]) =>
    id.length > 0 && id.length <= 200 && appearance && typeof appearance === "object" && !Array.isArray(appearance))
    .map(([id, appearance]) => [id, normalizeBackgroundAppearance(appearance)]));
}

export function normalizeBackgroundPresets(value: unknown): TerminalBackgroundPreset[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.filter(item => {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 200 || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim() || !item.appearance || typeof item.appearance !== "object" || Array.isArray(item.appearance)) return false;
    ids.add(item.id);
    return true;
  }).map(item => ({ id: item.id, name: item.name.trim().slice(0, 80), appearance: normalizeBackgroundAppearance(item.appearance) }));
}
