export interface AsciiPiece {
  meta: { cols?: number; rows?: number; fps?: number; still?: number; palette?: string[]; ground?: string; cell?: number; fineDots?: boolean; fullBleed?: boolean; cover?: boolean; contain?: boolean; options?: Record<string, unknown> };
  default(options: Record<string, unknown>): (time: number, env: { paper: boolean; color?: Uint8Array }) => string;
}
export function mount(element: HTMLCanvasElement, piece: AsciiPiece, options?: { fps?: number; motion?: boolean }): () => void;
