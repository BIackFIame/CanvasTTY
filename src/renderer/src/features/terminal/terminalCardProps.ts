import type { SessionBounds } from "../../../../shared/contracts.ts";

/** Two snap target lists with the same bounds in the same order. */
export function sameBoundsList(a: readonly SessionBounds[], b: readonly SessionBounds[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left === right) continue;
    if (
      left.position.x !== right.position.x
      || left.position.y !== right.position.y
      || left.size.width !== right.size.width
      || left.size.height !== right.size.height
    ) return false;
  }
  return true;
}

/**
 * React.memo equality for a canvas card: every prop by identity, except `snapTargets`, which the workspace
 * rebuilds on every render and which compares by value. The workspace hands the card callbacks that stay
 * the same functions across renders (they call its latest handlers), so a camera pan, which changes none of
 * a card's props, renders no card; any real change (session, zoom, focus, a moved neighbour) still does.
 */
export function canvasCardPropsEqual<P extends { snapTargets: readonly SessionBounds[] }>(previous: P, next: P): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as Array<keyof P>);
  for (const key of keys) {
    if (key === "snapTargets") {
      if (!sameBoundsList(previous.snapTargets, next.snapTargets)) return false;
    } else if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }
  return true;
}
