import { normalizeExternalUrl } from "../../../../shared/externalUrl.ts";

export interface TerminalLinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalLinkBuffer {
  getLine(index: number): {
    readonly isWrapped?: boolean;
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  } | undefined;
}

/**
 * OSC 8 links may display one URL while carrying a different hidden target.
 * Prefer the visible value only when the whole row-local label is independently
 * a complete non-credentialed HTTP(S) URL. Descriptive labels and any segment
 * touching a soft-wrap boundary keep the explicit OSC target.
 */
export function terminalLinkTarget(
  oscTarget: string,
  range: TerminalLinkRange,
  buffer: TerminalLinkBuffer,
  columns: number
): string {
  if (
    range.start.y !== range.end.y
    || range.start.x < 1
    || range.end.x < range.start.x
    || !Number.isInteger(columns)
    || columns < 1
  ) {
    return oscTarget;
  }
  const line = buffer.getLine(range.start.y - 1);
  // xterm exposes a wrapped OSC 8 hyperlink as a separate row-local range for
  // each physical row. Never treat a continuation row or a range reaching the
  // right edge as the complete visible label.
  if (!line || line.isWrapped || range.end.x >= columns) return oscTarget;
  const visible = line.translateToString(false, range.start.x - 1, range.end.x).trim();
  return completeVisibleHttpUrl(visible) ?? oscTarget;
}

function completeVisibleHttpUrl(value: string): string | null {
  let canonical: string;
  try {
    canonical = normalizeExternalUrl(value);
  } catch {
    return null;
  }
  const hostname = new URL(canonical).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "localhost.") return canonical;
  if (validIpv4(hostname) || validIpv6(hostname)) return canonical;
  const dnsName = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (dnsName.length === 0 || dnsName.length > 253) return null;
  const labels = dnsName.split(".");
  if (labels.length < 2 || labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ))) return null;
  return canonical;
}

function validIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => (
    /^\d{1,3}$/.test(part) && Number(part) <= 255
  ));
}

function validIpv6(hostname: string): boolean {
  return hostname.startsWith("[") && hostname.endsWith("]") && hostname.includes(":");
}
