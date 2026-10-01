// Size breakdown of a packaged macOS CanvasTTY.app for scripts/bench/baseline.mjs (--size / --size-only):
// bundle total, Electron framework, locales, helper apps, Resources, app.asar by top folder, largest files in the
// asar, and the node_modules packed into the asar that nothing in out/main or out/preload can load at runtime
// (the renderer is bundled by Vite, so its dependencies are dead weight in the asar).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MB = 1024 * 1024;
const mb = (bytes) => Math.round((bytes / MB) * 10) / 10;

/** Allocated size of a path in bytes (du -sk: what the disk and a zip start from). */
function du(path) {
  if (!existsSync(path)) return 0;
  return Number(execFileSync("/usr/bin/du", ["-sk", path], { encoding: "utf8" }).split(/\s+/u)[0]) * 1024;
}
function children(path) {
  return existsSync(path) ? readdirSync(path).map((name) => ({ name, bytes: du(join(path, name)) })).sort((a, b) => b.bytes - a.bytes) : [];
}

/** Every file in the asar header with its size (unpacked entries marked). */
function asarFiles(asarPath) {
  const { getRawHeader } = require("@electron/asar");
  const { header } = getRawHeader(asarPath);
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, path);
      else if (entry.size !== undefined) files.push({ path, bytes: entry.size, unpacked: Boolean(entry.unpacked) });
    }
  };
  walk(header, "");
  return files;
}

/** Bare module specifiers the built main and preload bundles can load (require, import, lazyRequire). */
function runtimeSpecifiers(files, read) {
  const found = new Set();
  const pattern = /(?:require(?:\$\d+)?|lazyRequire|import)\(\s*["']([^"'./][^"']*)["']\s*\)|from\s+["']([^"'./][^"']*)["']/gu;
  for (const file of files) {
    for (const match of read(file).matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith("node:") || specifier === "electron") continue;
      const parts = specifier.split("/");
      found.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  return found;
}

export function appSize(appPath, root) {
  const contents = join(appPath, "Contents");
  const frameworks = join(contents, "Frameworks");
  const resources = join(contents, "Resources");
  const electronFramework = join(frameworks, "Electron Framework.framework");
  const frameworkResources = join(electronFramework, "Versions", "A", "Resources");
  const locales = existsSync(frameworkResources) ? readdirSync(frameworkResources).filter((name) => name.endsWith(".lproj")) : [];
  const localeBytes = locales.reduce((sum, name) => sum + du(join(frameworkResources, name)), 0);
  const asarPath = join(resources, "app.asar");
  const files = existsSync(asarPath) ? asarFiles(asarPath) : [];
  const { extractFile } = require("@electron/asar");
  const packed = files.filter((file) => !file.unpacked);
  const byTop = {};
  for (const file of packed) {
    const parts = file.path.split("/");
    const key = parts[0] === "node_modules" ? `node_modules/${parts[1].startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1]}`
      : parts[0] === "out" ? parts.slice(0, Math.min(parts.length - 1, parts[1] === "renderer" ? 3 : 2)).join("/") : parts[0];
    byTop[key] = (byTop[key] ?? 0) + file.bytes;
  }
  // Runtime closure: what main/preload name, plus those packages' dependencies (as packed in the asar).
  const entryFiles = packed.filter((file) => /^out\/(main|preload)\/.*\.(c?js|mjs)$/u.test(file.path)).map((file) => file.path);
  const direct = runtimeSpecifiers(entryFiles, (path) => extractFile(asarPath, path).toString("utf8"));
  const packageJson = (name) => {
    try { return JSON.parse(extractFile(asarPath, `node_modules/${name}/package.json`).toString("utf8")); } catch { return null; }
  };
  const needed = new Set();
  const queue = [...direct];
  while (queue.length) {
    const name = queue.pop();
    if (needed.has(name)) continue;
    needed.add(name);
    const pkg = packageJson(name);
    for (const dependency of Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.optionalDependencies ?? {}) })) queue.push(dependency);
  }
  const packages = Object.entries(byTop).filter(([key]) => key.startsWith("node_modules/")).map(([key, bytes]) => ({ name: key.slice(13), bytes }));
  const unused = packages.filter((pkg) => !needed.has(pkg.name)).sort((a, b) => b.bytes - a.bytes);
  const helpers = existsSync(frameworks) ? readdirSync(frameworks).filter((name) => name.endsWith(".app")) : [];
  const electronBinary = join(electronFramework, "Versions", "A", "Electron Framework");
  return {
    app: appPath,
    totalMb: mb(du(appPath)),
    frameworksMb: mb(du(frameworks)),
    electronFrameworkMb: mb(du(electronFramework)),
    electronFrameworkBinaryMb: existsSync(electronBinary) ? mb(statSync(electronBinary).size) : null,
    frameworksBreakdown: children(frameworks).map(({ name, bytes }) => ({ name, mb: mb(bytes) })),
    helperApps: helpers.length,
    locales: { count: locales.length, mb: mb(localeBytes), largest: locales.map((name) => ({ name, mb: mb(du(join(frameworkResources, name))) })).sort((a, b) => b.mb - a.mb).slice(0, 3) },
    frameworkResourcesMb: children(frameworkResources).filter((entry) => !entry.name.endsWith(".lproj")).slice(0, 8).map(({ name, bytes }) => ({ name, mb: mb(bytes) })),
    resourcesMb: mb(du(resources)),
    resourcesBreakdown: children(resources).slice(0, 12).map(({ name, bytes }) => ({ name, mb: mb(bytes) })),
    asar: {
      mb: existsSync(asarPath) ? mb(statSync(asarPath).size) : null,
      files: packed.length,
      byFolder: Object.entries(byTop).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, bytes]) => ({ name, mb: mb(bytes) })),
      largest: [...packed].sort((a, b) => b.bytes - a.bytes).slice(0, 15).map((file) => ({ path: file.path, kb: Math.round(file.bytes / 1024) })),
      rendererImagesMb: mb(packed.filter((file) => /^out\/renderer\/.*\.(png|jpe?g|gif|webp|ico)$/u.test(file.path)).reduce((sum, file) => sum + file.bytes, 0)),
      runtimeDependencies: [...needed].sort(),
      unusedNodeModules: { count: unused.length, mb: mb(unused.reduce((sum, pkg) => sum + pkg.bytes, 0)), top: unused.slice(0, 15).map((pkg) => ({ name: pkg.name, kb: Math.round(pkg.bytes / 1024) })) }
    },
    unpackedMb: mb(du(join(resources, "app.asar.unpacked"))),
    outMb: root ? mb(du(join(root, "out"))) : null
  };
}

export function formatSize(size) {
  const lines = [];
  lines.push(`Bundle ${size.totalMb} MB: Frameworks ${size.frameworksMb} MB (Electron Framework ${size.electronFrameworkMb} MB, binary ${size.electronFrameworkBinaryMb} MB, ${size.helperApps} helper apps), Resources ${size.resourcesMb} MB`);
  lines.push(`Locales: ${size.locales.count} .lproj, ${size.locales.mb} MB`);
  lines.push(`Frameworks: ${size.frameworksBreakdown.map((entry) => `${entry.name} ${entry.mb}`).join(", ")}`);
  lines.push(`Resources: ${size.resourcesBreakdown.map((entry) => `${entry.name} ${entry.mb}`).join(", ")}`);
  lines.push(`app.asar ${size.asar.mb} MB (${size.asar.files} files; renderer images ${size.asar.rendererImagesMb} MB), unpacked ${size.unpackedMb} MB`);
  lines.push(`asar by folder: ${size.asar.byFolder.map((entry) => `${entry.name} ${entry.mb}`).join(", ")}`);
  lines.push(`largest: ${size.asar.largest.map((entry) => `${entry.path} ${entry.kb} KB`).join(", ")}`);
  lines.push(`runtime deps of out/main+preload: ${size.asar.runtimeDependencies.join(", ")}`);
  lines.push(`unused node_modules in asar: ${size.asar.unusedNodeModules.count} packages, ${size.asar.unusedNodeModules.mb} MB: ${size.asar.unusedNodeModules.top.map((pkg) => `${pkg.name} ${pkg.kb} KB`).join(", ")}`);
  return lines.join("\n");
}
