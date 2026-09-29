export interface SkinRect { x: number; y: number; width: number; height: number }
export interface TiledFrame {
  corners: readonly [SkinRect, SkinRect, SkinRect, SkinRect];
  edges: readonly [SkinRect, SkinRect, SkinRect, SkinRect];
  cornerWidth: number;
  cornerHeight: number;
  edgeThickness: number;
  tileLength: number;
  edgeOffsets: readonly [number, number, number, number];
}
export interface SkinDefinition {
  id: string;
  atlasUrl: string;
  frame: TiledFrame;
  safeInsets: { left: number; right: number; bottom: number };
}

export function createSakuraSkin(atlasUrl: string): SkinDefinition {
  return {
    id: "sakura",
    atlasUrl,
    frame: {
      corners: [
        { x: 0, y: 0, width: 360, height: 260 },
        { x: 1176, y: 0, width: 360, height: 260 },
        { x: 0, y: 764, width: 360, height: 260 },
        { x: 1176, y: 764, width: 360, height: 260 }
      ],
      edges: [
        { x: 690, y: 58, width: 56, height: 80 },
        { x: 1410, y: 460, width: 80, height: 56 },
        { x: 690, y: 888, width: 56, height: 80 },
        { x: 46, y: 460, width: 80, height: 56 }
      ],
      cornerWidth: 68,
      cornerHeight: 58,
      edgeThickness: 22,
      tileLength: 18,
      edgeOffsets: [12, 29, 34, 7]
    },
    safeInsets: { left: 28, right: 28, bottom: 58 }
  };
}
