import assert from "node:assert/strict";
import test from "node:test";
import { findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";

// The launcher's Advanced section lists launch plugins for the chosen agent. Switching the agent must
// not leave the previous agent's plugins tickable while the new list loads: ticking one would send its
// options with a launch they do not apply to.
const { LaunchOptionsSection, __render, __flush, __reset } = await importWithFakeReact(
  "src/renderer/src/features/launcher/LaunchOptionsSection.tsx",
  "LaunchOptionsSection"
);

function launchPlugin(id, appliesTo) {
  return {
    manifest: {
      id, name: id, version: "1.0.0", permissions: ["launch:contribute"],
      services: [{ id: "svc", launch: { appliesTo, fields: [{ key: "on", kind: "boolean", label: "On" }] } }]
    },
    sourceUrl: "", enabled: true, installedAt: 0, selectedModules: [], enabledHooks: [],
    nativeCodeTrusted: true, decisionsMayAllow: false
  };
}

function harness(provider) {
  const lists = [];
  const sent = [];
  globalThis.window = {
    canvasTTY: {
      plugins: {
        list() { const reply = Promise.withResolvers(); lists.push(reply); return reply.promise; },
        launchFieldOptions: async () => ({})
      }
    }
  };
  const props = {
    provider, locale: "en",
    onChange(options) { sent.push({ provider: props.provider, options }); },
    onEnvironmentChange() {}
  };
  __reset();
  let tree = __render(LaunchOptionsSection, props);
  return {
    lists, sent, props,
    render() {
      // Apply updates and re-render until effects stop queueing more, like React settling.
      for (let round = 0; round < 5; round++) { __flush(); tree = __render(LaunchOptionsSection, props); }
      return tree;
    },
    pluginIds: () => findAll(tree, (node) => node.type === "fieldset" && typeof node.key === "string" && !node.key.includes("/")).map((node) => node.key),
    tick(pluginId) {
      const fieldset = findAll(tree, (node) => node.type === "fieldset" && node.key === pluginId)[0];
      const box = findAll(fieldset, (node) => node.type === "input" && node.props.type === "checkbox")[0];
      box.props.onChange({ target: { checked: true } });
    }
  };
}

const installed = [launchPlugin("codex-only", ["codex"]), launchPlugin("claude-only", ["claude"])];

test("switching the agent hides the previous agent's launch plugins until its own list arrives", async (t) => {
  t.after(() => { delete globalThis.window; });
  const view = harness("codex");
  view.lists[0].resolve(installed);
  await tick();
  view.render();
  assert.deepEqual(view.pluginIds(), ["codex-only"]);

  view.props.provider = "claude";
  view.render();
  assert.deepEqual(view.pluginIds(), [], "nothing of the codex list is offered for claude");
  assert.equal(view.lists.length, 2);

  view.lists[1].resolve(installed);
  await tick();
  view.render();
  assert.deepEqual(view.pluginIds(), ["claude-only"]);
  view.tick("claude-only");
  view.render();
  assert.deepEqual(view.sent.at(-1), { provider: "claude", options: { "claude-only": { on: false } } });
  assert.ok(view.sent.every((entry) => entry.provider === "codex" || !("codex-only" in entry.options)));
});

test("a plugin list answered after the agent changed is ignored", async (t) => {
  t.after(() => { delete globalThis.window; });
  const view = harness("codex");
  view.props.provider = "claude";
  view.render();
  view.lists[0].resolve(installed);
  await tick();
  view.render();
  assert.deepEqual(view.pluginIds(), []);
  view.lists[1].resolve(installed);
  await tick();
  view.render();
  assert.deepEqual(view.pluginIds(), ["claude-only"]);
});
