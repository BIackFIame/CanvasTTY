/**
 * CanvasTTY Edge: a personal build that installs next to the official CanvasTTY as a separate app. It has its own
 * name, bundle id and data folder, so it never reads or writes the official app's profile, and it never updates
 * itself from the official release channels (it is rebuilt from its own branch instead).
 */
declare const __CANVASTTY_BUILD_COMMIT__: string | undefined;

export const EDITION = {
  name: "CanvasTTY Edge",
  /** The folder under the OS application-data directory (the official app uses "canvastty"). */
  dataFolder: "canvastty-edge",
  bundleId: "io.github.howdeploy.canvastty.edge",
  selfUpdates: false
} as const;

/** The short commit the build was made from ("dev" when it was not injected at build time). */
export const BUILD_COMMIT: string = typeof __CANVASTTY_BUILD_COMMIT__ === "string" && __CANVASTTY_BUILD_COMMIT__
  ? __CANVASTTY_BUILD_COMMIT__ : "dev";

/** "CanvasTTY Edge 1.8.2 (abcd1234)": window title, About panel and the updates section. */
export function editionLabel(version: string): string {
  return `${EDITION.name} ${version} (${BUILD_COMMIT})`;
}
