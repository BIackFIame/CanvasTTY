import type { CanvasMaterial, MaterialsSnapshot, SessionBounds } from "../../../../shared/contracts.ts";

export const EMPTY_MATERIALS_SNAPSHOT: MaterialsSnapshot = {
  revision: 0,
  materials: []
};

export function acceptMaterialsSnapshot(current: MaterialsSnapshot, next: MaterialsSnapshot): MaterialsSnapshot {
  return next.revision < current.revision ? current : next;
}

export function withPendingBounds(
  materials: readonly CanvasMaterial[],
  pending: Map<string, SessionBounds>
): CanvasMaterial[] {
  const present = new Set(materials.map((material) => material.id));
  for (const id of [...pending.keys()]) if (!present.has(id)) pending.delete(id);
  return materials.map((material) => {
    const bounds = pending.get(material.id);
    if (!bounds) return material;
    if (sameBounds(material, bounds)) {
      pending.delete(material.id);
      return material;
    }
    return { ...material, position: { ...bounds.position }, size: { ...bounds.size } };
  });
}

function sameBounds(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.size.width === right.size.width
    && left.size.height === right.size.height;
}
