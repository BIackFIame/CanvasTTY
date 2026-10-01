/**
 * React.memo equality for a canvas card: every prop by identity. The workspace hands the card callbacks and a
 * snap-target getter that stay the same functions across renders (they read its latest state), so a camera pan
 * or a neighbour's move, which changes none of a card's props, renders no card; any real change (session, zoom,
 * focus) still does.
 */
export function canvasCardPropsEqual<P extends object>(previous: P, next: P): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as Array<keyof P>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
}
