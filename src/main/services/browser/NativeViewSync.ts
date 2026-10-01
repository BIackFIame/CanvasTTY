/**
 * The last state CanvasTTY gave each native view, so a sync that changes nothing makes no Electron call.
 *
 * BrowserService.syncViews runs on every viewport report, window move, gesture step and tab change, and sets
 * the clip view's and the page's bounds, visibility, corner radius and background throttling each time. During
 * a canvas pan only the bounds move; the rest was re-sent unchanged on every step (and for every hidden tab).
 * Every change of these properties must go through one instance, or its record would go stale.
 */

export interface NativeRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeViewLike {
  setBounds(bounds: NativeRectangle): void;
  setVisible(visible: boolean): void;
  setBorderRadius(radius: number): void;
}

export interface ThrottleTarget {
  setBackgroundThrottling(allowed: boolean): void;
}

export class NativeViewSync {
  private readonly bounds = new WeakMap<object, NativeRectangle>();
  private readonly visible = new WeakMap<object, boolean>();
  private readonly radius = new WeakMap<object, number>();
  private readonly throttling = new WeakMap<object, boolean>();

  setBounds(view: NativeViewLike, next: NativeRectangle): void {
    const previous = this.bounds.get(view);
    if (previous && previous.x === next.x && previous.y === next.y
      && previous.width === next.width && previous.height === next.height) return;
    view.setBounds(next);
    this.bounds.set(view, { x: next.x, y: next.y, width: next.width, height: next.height });
  }

  setVisible(view: NativeViewLike, visible: boolean): void {
    if (this.visible.get(view) === visible) return;
    view.setVisible(visible);
    this.visible.set(view, visible);
  }

  setBorderRadius(view: NativeViewLike, radius: number): void {
    if (this.radius.get(view) === radius) return;
    view.setBorderRadius(radius);
    this.radius.set(view, radius);
  }

  setBackgroundThrottling(target: ThrottleTarget, allowed: boolean): void {
    if (this.throttling.get(target) === allowed) return;
    target.setBackgroundThrottling(allowed);
    this.throttling.set(target, allowed);
  }
}
