import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// Drive the real HUD's state and click handlers without a DOM. Effects perform IPC,
// so the harness supplies the already-loaded history instead.
const react = `
let state, cursor;
export function reset(initial) { state = initial; }
export function render(component, props) { cursor = 0; return component(props); }
export function useState(initial) {
  const i = cursor++;
  if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial;
  return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }];
}
export const useMemo = fn => fn();
export const useCallback = fn => fn;
export const useRef = current => ({ current });
export function useEffect() {}
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
`;
const { outputFiles } = await build({
  stdin: {
    contents: 'export { AgentChatHistoryHud } from "./src/renderer/src/features/workspace/AgentChatHistoryHud.tsx"; export { reset, render } from "react";',
    resolveDir: process.cwd(), loader: "ts"
  },
  jsx: "automatic", bundle: true, platform: "node", format: "esm", write: false, loader: { ".svg": "text" },
  plugins: [{ name: "hud-react", setup(builder) {
    builder.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, () => ({ path: "react", namespace: "hud-react" }));
    builder.onLoad({ filter: /.*/, namespace: "hud-react" }, () => ({ contents: react, loader: "js" }));
  } }]
});
const { AgentChatHistoryHud, reset, render } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

function find(node, predicate, found = []) {
  if (Array.isArray(node)) { node.forEach(child => find(child, predicate, found)); return found; }
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  find(node.props?.children, predicate, found);
  return found;
}
const rows = tree => find(tree, node => node.props?.className?.startsWith("agent-chat-history__item"));

test("collapsing a project preserves only its open conversations and focuses their terminals", () => {
  const items = ["working", "idle", "exited", "historical"].map(id => ({
    id, provider: "omp", cwd: "/project", title: id, lastActivityAt: Date.now()
  }));
  const sessions = items.slice(0, 3).map((item, index) => ({
    id: `terminal-${item.id}`, provider: "omp", threadId: item.id, cwd: "/project",
    status: index === 0 ? "working" : "idle", exitCode: index === 2 ? 0 : null
  }));
  // A different agent's identical conversation id must not mark an OMP chat active.
  sessions.push({ ...sessions[0], provider: "codex", threadId: "historical" });
  reset([["omp"], "omp", { omp: { provider: "omp", items } }]);
  let focused;
  const props = { settings: { locale: "en" }, sessions,
    onFocusSession: session => { focused = session; }, onResume: () => assert.fail("an open chat must focus") };
  let tree = render(AgentChatHistoryHud, props);
  assert.equal(rows(tree).length, 4);
  find(tree, node => node.props?.className === "agent-chat-history__project-toggle")[0].props.onClick();
  tree = render(AgentChatHistoryHud, props);
  assert.deepEqual(rows(tree).map(row => row.props.children[0].props.children), ["working", "idle"]);
  rows(tree)[1].props.onClick();
  assert.equal(focused.id, "terminal-idle");
  tree = render(AgentChatHistoryHud, { ...props, sessions: [] });
  assert.equal(rows(tree).length, 0);
  find(tree, node => node.props?.className === "agent-chat-history__project-toggle")[0].props.onClick();
  assert.equal(rows(render(AgentChatHistoryHud, props)).length, 4);
});
