import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The provider key fields in Settings, driven the way React drives them. React runs a functional state
// updater later than the change handler whenever an earlier update of that component is still pending
// (the second keystroke, or a paste over text already in the field). By then the synthetic event has
// finished dispatching and `event.currentTarget` is null. An updater that reads the event then throws
// during render, and React unmounts the whole application: the window turns black.
//
// This harness bundles the real component against a minimal React stand-in whose state updaters always
// run after dispatch, which is the ordering that broke the MiniMax key field in the packaged app.
const FAKE_REACT = `
let state = [];
let cursor = 0;
const queue = [];
export function useState(initial) {
  const index = cursor++;
  if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
  return [state[index], (update) => { queue.push([index, update]); }];
}
export function useEffect() {}
export function jsx(type, props) { return { type, props }; }
export const jsxs = jsx;
export const Fragment = "fragment";
export function __render(component, props) { cursor = 0; return component(props); }
export function __flush() {
  for (const [index, update] of queue.splice(0)) state[index] = typeof update === "function" ? update(state[index]) : update;
}
export function __reset() { state = []; cursor = 0; queue.length = 0; }
export default { useState, useEffect };
`;

const root = fileURLToPath(new URL("..", import.meta.url));
const { outputFiles } = await build({
  stdin: {
    contents: 'export { ProviderSecretsSettings } from "./src/renderer/src/features/settings/ProviderSecretsSettings.tsx"; export { __render, __flush, __reset } from "react";',
    resolveDir: root,
    loader: "ts"
  },
  jsx: "automatic",
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "fake-react",
    setup(builder) {
      builder.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, () => ({ path: "react", namespace: "fake-react" }));
      builder.onLoad({ filter: /.*/, namespace: "fake-react" }, () => ({ contents: FAKE_REACT, loader: "js" }));
    }
  }]
});
const { ProviderSecretsSettings, __render, __flush, __reset } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}
const keyField = (tree) => findAll(tree, (node) => node.type === "input" && /MINIMAX_API_KEY/u.test(node.props["aria-label"] ?? ""))[0];

/** One React change event: currentTarget is the field while the handler runs, null once dispatch ends. */
function change(field, value) {
  const element = { value };
  const event = { currentTarget: element, target: element };
  field.props.onChange(event);
  event.currentTarget = null;
}

// MiniMax keys are `sk-cp-` / `sk-api-` + a long [A-Za-z0-9_-] body. These are FAKE keys of that shape.
function fakeKey(length, prefix = "sk-cp-") {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let seed = length;
  let out = prefix;
  while (out.length < length) { seed = (seed * 1103515245 + 12345) >>> 0; out += alphabet[(seed >>> 8) % alphabet.length]; }
  return out;
}

test("pasting over a provider key draft keeps the settings rendered, for keys of any length", () => {
  const keys = [
    fakeKey(120), fakeKey(200, "sk-api-"), fakeKey(250), fakeKey(500), fakeKey(2_000), fakeKey(10_000),
    `${fakeKey(180)}\n`, `${fakeKey(180)} `
  ];
  __reset();
  const props = { locale: "en" };
  let tree = __render(ProviderSecretsSettings, props);
  const started = performance.now();
  for (const key of keys) {
    // A first character in the field, then the paste replacing it: two updates before one render.
    change(keyField(tree), key.slice(0, 1));
    change(keyField(tree), key);
    assert.doesNotThrow(__flush, `a ${key.length}-character key must not break the render`);
    tree = __render(ProviderSecretsSettings, props);
    assert.equal(keyField(tree).props.value, key);
    const saveButton = findAll(tree, (node) => node.type === "button" && node.props.children === "Save")
      .find((button) => button.props.disabled === false);
    assert.ok(saveButton, "a pasted key enables its Save button");
  }
  assert.ok(performance.now() - started < 1_000, "typing and rendering long keys stays fast");
});

test("renderer state updaters never read a React event after its dispatch", async () => {
  // Static guard for the same bug class anywhere in the renderer, one line at a time:
  // `setX((prev) => ... event.currentTarget ...)`. Read the value first, then hand it to the updater.
  const directory = join(root, "src", "renderer", "src");
  const files = (await readdir(directory, { recursive: true })).filter((file) => /\.tsx?$/u.test(file));
  const offenders = [];
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    const pattern = /\bset[A-Z]\w*\(\s*\(?\s*(\w+)?\s*\)?\s*=>[^;\n]*?\b(event|e|ev)\.(currentTarget|target)\b/gu;
    for (const match of source.matchAll(pattern)) offenders.push(`${file}: ${match[0].slice(0, 120)}`);
  }
  assert.deepEqual(offenders, []);
});
