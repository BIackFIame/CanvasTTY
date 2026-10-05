import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fire, installMiniDom, typeInto } from "./helpers/mini-dom.mjs";

// react-dom detects the DOM when it is first evaluated, so the document must exist before the bundle loads.
const { document, restore } = installMiniDom();
after(restore);

// The terminal card's code (xterm) loads after the first frame. These tests mount the real deferred card with
// real React and a terminal import the test controls: delayed, failing, or a card that throws while rendering.
// React stays outside the bundle so the component and the test share Node's copy of it.
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/features/terminal/DeferredTerminalCard.tsx", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  write: false,
  plugins: [{
    name: "node-react",
    setup(builder) {
      builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
    }
  }]
});
const { createComponentLoader, DeferredTerminalCard, useDeferredComponent } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const session = (id) => ({
  id, provider: "terminal", title: `Shell ${id}`, status: "running", startedAt: 1,
  position: { x: 0, y: 0 }, size: { width: 400, height: 300 }
});
const shortcuts = { terminalCopy: "Mod+C", terminalPaste: "Mod+V" };

/** What the real card does with input, without xterm: one field that sends what is typed to the PTY. */
function stubCard(broken = new Set()) {
  return function StubTerminalCard({ sessionId, focused }) {
    if (broken.has(sessionId)) throw new Error(`terminal ${sessionId} failed to draw`);
    return h("textarea", {
      "data-stub-card": sessionId,
      ref: (field) => { if (field && focused) field.focus(); },
      onInput: (event) => {
        const text = event.currentTarget.value;
        event.currentTarget.value = "";
        window.canvasTTY.terminal.input(sessionId, text);
      }
    });
  };
}

function Workspace({ loader, focusedId }) {
  const card = useDeferredComponent(loader, true);
  return h("main", null,
    h("section", { "data-other-surface": "browser" }, "Browser card"),
    ...["a", "b"].map((id) => h(DeferredTerminalCard, {
      key: id,
      card,
      inputHeld: false,
      loading: {
        session: session(id), locale: "en", borderSkin: "default", shortcuts, stackIndex: 1, fullscreen: false,
        selected: id === focusedId, groupSelected: false, focused: id === focusedId, focusRevision: 0,
        onInputHoldChange() {}, onSelect() {}
      },
      render: (Card) => h(Card, { sessionId: id, focused: id === focusedId })
    })));
}

function mount(t, loader, focusedId = "a") {
  const inputs = [];
  globalThis.canvasTTY = {
    terminal: { input: (id, text) => inputs.push([id, text]) },
    window: { isMacOS: true },
    clipboard: { hasImage: async () => false, readText: async () => "" }
  };
  const errors = [];
  t.mock.method(console, "error", (...args) => { errors.push(args.map(String).join(" ")); });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
    delete globalThis.canvasTTY;
  });
  const render = () => act(async () => root.render(h(Workspace, { loader, focusedId })));
  return { container, inputs, errors, render };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("keystrokes typed while the terminal code loads reach the PTY in order, then the loaded card takes over", async (t) => {
  const pending = deferred();
  const loader = createComponentLoader(() => pending.promise);
  const { container, inputs, render } = mount(t, loader);
  await render();

  const shells = container.querySelectorAll("article.terminal-card--loading");
  assert.equal(shells.length, 2, "both terminals show a loading shell");
  assert.equal(shells[0].getAttribute("aria-busy"), "true");
  const field = document.activeElement;
  assert.equal(field.tagName, "TEXTAREA", "the focused card's loading shell takes keystrokes");
  assert.equal(field.closest("article").getAttribute("data-session-id"), "a");

  await act(async () => {
    typeInto(field, "ec");
    fire(field, "keydown", { key: "Enter", code: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    typeInto(field, "ho");
  });
  assert.deepEqual(inputs, [["a", "ec"], ["a", "\r"], ["a", "ho"]], "typed text and keys are forwarded, in order");

  await act(async () => pending.resolve(stubCard()));
  assert.equal(container.querySelectorAll("article").length, 0, "the loading shells are gone");
  assert.equal(document.activeElement.getAttribute("data-stub-card"), "a", "the loaded card has the focus");
  await act(async () => { typeInto(document.activeElement, "!"); });
  assert.deepEqual(inputs.at(-1), ["a", "!"]);
  assert.equal(inputs.length, 4, "nothing typed before the swap was sent twice");
});

test("a failed terminal import affects only terminal cards and Retry loads them", async (t) => {
  let attempts = 0;
  const loader = createComponentLoader(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("chunk failed");
    return stubCard();
  });
  const { container, errors, render } = mount(t, loader);
  await render();

  assert.equal(container.querySelector("[data-other-surface]")?.textContent, "Browser card", "the rest of the window still renders");
  assert.equal(container.querySelectorAll("article.terminal-card--load-error").length, 2);
  assert.equal(container.querySelectorAll("[role=\"alert\"]").length, 2);
  assert.ok(errors.some((line) => line.includes("could not load the terminal panel")));

  await act(async () => { fire(container.querySelector("button"), "click"); });
  assert.equal(attempts, 2, "Retry requested the terminal code again");
  assert.equal(container.querySelectorAll("article").length, 0);
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["a", "b"]);
});

test("a terminal card that throws while drawing fails alone, and Retry mounts it again", async (t) => {
  const broken = new Set(["a"]);
  const Card = stubCard(broken);
  const loader = createComponentLoader(async () => Card);
  await loader.load();
  const { container, render } = mount(t, loader, "b");
  await render();

  assert.equal(container.querySelector("[data-other-surface]")?.textContent, "Browser card");
  const failed = container.querySelectorAll("article.terminal-card--load-error");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].getAttribute("data-session-id"), "a");
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["b"]);

  broken.delete("a");
  await act(async () => { fire(failed[0].querySelector("button"), "click"); });
  assert.equal(container.querySelectorAll("article").length, 0);
  assert.deepEqual(container.querySelectorAll("[data-stub-card]").map((node) => node.getAttribute("data-stub-card")), ["a", "b"]);
});
