// Benchmark harness: the app's child_process with /usr/bin/security refused (the app reads provider
// credentials from the macOS keychain; a benchmark must never touch it). Every other call is unchanged.
import * as real from "node:child_process";
export * from "node:child_process";

const refused = (file) => typeof file === "string" && /(^|\/)security$/u.test(file);
const refusedLine = (line) => typeof line === "string" && /(^|[\s/;&|])security(\s|$)/u.test(line);
const error = () => Object.assign(new Error("keychain access is off in the benchmark"), { code: 44 });
export function execFile(file, ...rest) {
  if (refused(file)) {
    const callback = rest.find((value) => typeof value === "function");
    if (callback) setImmediate(() => callback(error(), "", ""));
    return { on() {}, kill() {} };
  }
  return real.execFile(file, ...rest);
}
export function execFileSync(file, ...rest) {
  if (refused(file)) throw error();
  return real.execFileSync(file, ...rest);
}
export function spawn(command, ...rest) {
  if (refused(command)) throw error();
  return real.spawn(command, ...rest);
}
export function spawnSync(command, ...rest) {
  if (refused(command)) throw error();
  return real.spawnSync(command, ...rest);
}
export function exec(line, ...rest) {
  if (refusedLine(line)) throw error();
  return real.exec(line, ...rest);
}
export function execSync(line, ...rest) {
  if (refusedLine(line)) throw error();
  return real.execSync(line, ...rest);
}
export default { ...real, execFile, execFileSync, spawn, spawnSync, exec, execSync };
