import assert from "node:assert/strict";
import test from "node:test";
import { change, findAll, importWithFakeReact, tick } from "./helpers/fake-react.mjs";

// The API profile rows in Settings, driven through their handlers. A save is asynchronous (the settings
// store writes to disk), and the fields stay editable meanwhile: what the person types during that time
// must survive the save, and the save itself must not run twice.
const { ApiProfilesSettings, __render, __flush, __reset } = await importWithFakeReact(
  "src/renderer/src/features/settings/ApiProfilesSettings.tsx",
  "ApiProfilesSettings"
);

const PROFILE = Object.freeze({
  id: "gateway", name: "Gateway", protocol: "openai-compatible",
  baseUrl: "https://gateway.invalid/v1", secretRef: "OPENAI_API_KEY"
});

function harness() {
  const patches = [];
  const replies = [];
  const props = {
    settings: { locale: "en", apiProfiles: [PROFILE] },
    onChange(patch) {
      patches.push(patch);
      const reply = Promise.withResolvers();
      replies.push(reply);
      return reply.promise;
    }
  };
  __reset();
  let tree = __render(ApiProfilesSettings, props);
  return {
    patches,
    replies,
    props,
    get tree() { return tree; },
    render() { __flush(); tree = __render(ApiProfilesSettings, props); return tree; },
    field: (label) => findAll(tree, (node) => node.type === "input" && node.props["aria-label"] === label)[0],
    button: (label) => findAll(tree, (node) => node.type === "button" && node.props.children === label)[0]
  };
}

test("a second Save before the first finishes writes the profile once", async () => {
  const view = harness();
  change(view.field("Name"), "Gateway EU");
  view.render();
  const save = view.button("Save");
  save.props.onClick();
  save.props.onClick();
  view.render();
  assert.equal(view.button("Save").props.disabled, true);
  assert.equal(view.patches.length, 1);
  assert.equal(view.patches[0].apiProfiles[0].name, "Gateway EU");
  view.replies[0].resolve();
  await tick();
  view.props.settings = { ...view.props.settings, apiProfiles: view.patches[0].apiProfiles };
  view.render();
  assert.equal(view.field("Name").props.value, "Gateway EU");
  assert.equal(view.button("Save").props.disabled, true, "nothing left to save");
});

test("an edit made while a profile is saving survives the save", async () => {
  const view = harness();
  change(view.field("Name"), "Gateway EU");
  view.render();
  view.button("Save").props.onClick();
  view.render();
  change(view.field("Model"), "gpt-test");
  view.render();
  view.replies[0].resolve();
  await tick();
  view.props.settings = { ...view.props.settings, apiProfiles: view.patches[0].apiProfiles };
  view.render();
  assert.equal(view.patches[0].apiProfiles[0].defaultModel, undefined, "the save carried the submitted draft");
  assert.equal(view.field("Name").props.value, "Gateway EU");
  assert.equal(view.field("Model").props.value, "gpt-test");
  assert.equal(view.button("Save").props.disabled, false, "the later edit is still unsaved");
});

test("two edits applied in one batch both reach the draft", () => {
  const view = harness();
  change(view.field("Name"), "Gateway EU");
  change(view.field("Model"), "gpt-test");
  view.render();
  assert.equal(view.field("Name").props.value, "Gateway EU");
  assert.equal(view.field("Model").props.value, "gpt-test");
});
