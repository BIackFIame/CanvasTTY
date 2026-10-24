import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/** The short commit CanvasTTY Edge shows next to its version (window title, About, Settings → Updates). */
function buildCommit(): string {
  const fromEnv = process.env.CANVASTTY_BUILD_COMMIT?.trim();
  if (fromEnv && /^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv.slice(0, 8);
  try {
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "dev";
  }
}
const BUILD_COMMIT = JSON.stringify(buildCommit());

export default defineConfig({
  main: {
    define: {
      __CANVASTTY_BUILD_COMMIT__: BUILD_COMMIT,
      __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__: JSON.stringify(
        process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
          || process.env.CANVASTTY_GITHUB_CLIENT_ID?.trim()
          || ""
      )
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          browser: resolve("src/preload/browser.ts"),
          plugin: resolve("src/preload/plugin.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    define: { __CANVASTTY_BUILD_COMMIT__: BUILD_COMMIT },
    // electron-vite leaves every bundle unminified; the renderer's (React, xterm and the app, about 1.8 MB)
    // is parsed on every window load, so it is minified. Source maps stay off, as before.
    build: {
      minify: "esbuild"
    }
  }
});
