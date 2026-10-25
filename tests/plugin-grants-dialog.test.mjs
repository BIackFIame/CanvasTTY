import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The real consent dialog, bundled against a minimal React stand-in (as provider-secrets-settings does): state,
// refs and effects are driven by hand so the Allow button's arming can be checked step by step.
const FAKE_REACT = `
let state = [];
let cursor = 0;
let effects = [];
const queue = [];
export function useState(initial) {
  const index = cursor++;
  if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
  return [state[index], (update) => { queue.push([index, update]); }];
}
export function useRef(initial) {
  const index = cursor++;
  if (!(index in state)) state[index] = { current: initial };
  return state[index];
}
export function useEffect(effect) { effects.push(effect); }
export function jsx(type, props) { return { type, props }; }
export const jsxs = jsx;
export const Fragment = "fragment";
export function __render(component, props) { cursor = 0; effects = []; return component(props); }
export function __effects() { for (const effect of effects.splice(0)) effect(); }
export function __flush() {
  for (const [index, update] of queue.splice(0)) state[index] = typeof update === "function" ? update(state[index]) : update;
}
export function __reset() { state = []; cursor = 0; queue.length = 0; effects = []; }
export default { useState, useRef, useEffect };
`;

const root = fileURLToPath(new URL("..", import.meta.url));
const { outputFiles } = await build({
  stdin: {
    contents: 'export { GrantsDialog, requestGrants } from "./src/renderer/src/features/plugins/grantsRequest.tsx"; export { parseGrantRequest, planGrants } from "./src/renderer/src/features/plugins/grantsPlan.ts"; export { __render, __effects, __flush, __reset } from "react";',
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
      builder.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: "react-dom", namespace: "fake-react" }));
      builder.onLoad({ filter: /^react-dom$/, namespace: "fake-react" }, () => ({ contents: "export function createRoot() { throw new Error('no DOM'); }", loader: "js" }));
      builder.onLoad({ filter: /^react$/, namespace: "fake-react" }, () => ({ contents: FAKE_REACT, loader: "js" }));
    }
  }]
});
const { GrantsDialog, requestGrants, parseGrantRequest, planGrants, __render, __effects, __flush, __reset } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

const plugin = (id, extra = {}) => ({
  manifest: { apiVersion: 2, id, name: id, version: "1.0.0", description: "x", contributions: [], permissions: ["sessions:launch"],
    services: [{ id: "main", title: "Main", entry: "s.mjs" }] },
  sourceUrl: `https://github.com/example/${id}.git`, enabled: true, installedAt: 1, selectedModules: [], enabledHooks: [],
  nativeCodeTrusted: true, decisionsMayAllow: false, mayStartOrchestrators: false, ...extra
});

test("a request without the person's fresh activation is refused before anything is asked or shown", async () => {
  const asked = [];
  globalThis.window = { canvasTTY: { plugins: new Proxy({}, { get: (_, name) => () => { asked.push(name); return Promise.resolve([]); } }) } };
  const params = { items: [{ kind: "mayStartOrchestrators" }] };
  await assert.rejects(requestGrants({ plugin: plugin("a"), params, personInFrame: true, activated: false, locale: "en" }), /within a few seconds/u);
  await assert.rejects(requestGrants({ plugin: plugin("a"), params, personInFrame: false, activated: true, locale: "en" }), /action of the person/u);
  // Without an explicit value the host reads its own window's activation (a page cannot set it).
  globalThis.navigator ??= {};
  Object.defineProperty(globalThis.navigator, "userActivation", { value: { isActive: false }, configurable: true });
  await assert.rejects(requestGrants({ plugin: plugin("a"), params, personInFrame: true, locale: "en" }), /within a few seconds/u);
  assert.deepEqual(asked, []);
});

test("Allow stays disabled for 1 s after the dialog appears and again after a re-layout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = {};
  globalThis.window = {
    addEventListener: (name, listener) => { (listeners[name] ??= []).push(listener); },
    removeEventListener: () => {}
  };
  const plugins = [plugin("requester")];
  const plan = await planGrants("requester", parseGrantRequest({ items: [{ kind: "mayStartOrchestrators" }] }), plugins, async () => null);
  __reset();
  const props = { plan, plugins, locale: "en", onDone: () => {} };
  const allow = () => findAll(__render(GrantsDialog, props), (node) => node.type === "button" && node.props.className === "grants-dialog__allow")[0];
  let button = allow();
  __effects();
  // The high-impact row starts unticked: tick it as the person would.
  const box = findAll(__render(GrantsDialog, props), (node) => node.type === "input")[0];
  __effects();
  box.props.onChange({ currentTarget: { checked: true } });
  __flush();
  button = allow();
  assert.equal(button.props.disabled, true, "not armed yet");
  t.mock.timers.tick(999);
  __flush();
  assert.equal(allow().props.disabled, true);
  t.mock.timers.tick(1);
  __flush();
  assert.equal(allow().props.disabled, false, "armed after 1 s");
  // The window resizes (the dialog moves): disarmed again for 1 s.
  for (const listener of listeners.resize ?? []) listener();
  __flush();
  assert.equal(allow().props.disabled, true);
  t.mock.timers.tick(1_000);
  __flush();
  assert.equal(allow().props.disabled, false);
});
