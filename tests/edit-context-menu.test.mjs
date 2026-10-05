import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { attachEditContextMenu, editContextMenuTemplate } from "../src/main/editContextMenu.ts";

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: true, canEditRichly: false };

test("an editable field (app or plugin page) gets native Cut, Copy, Paste and Select All", () => {
  const template = editContextMenuTemplate({ isEditable: true, selectionText: "", editFlags: flags }, "ru");
  assert.deepEqual(template.filter(item => item.role).map(item => [item.role, item.label]),
    [["cut", "Вырезать"], ["copy", "Скопировать"], ["paste", "Вставить"], ["selectAll", "Выбрать все"]]);
  const empty = editContextMenuTemplate({ isEditable: true, selectionText: "", editFlags: { ...flags, canCut: false, canCopy: false } }, "en");
  assert.deepEqual(empty.filter(item => item.role).map(item => [item.role, item.enabled]),
    [["cut", false], ["copy", false], ["paste", true], ["selectAll", true]]);
});

test("selected page text gets Copy only; anything else gets no menu", () => {
  assert.deepEqual(editContextMenuTemplate({ isEditable: false, selectionText: "abc", editFlags: flags }, "en").map(item => item.role), ["copy"]);
  assert.deepEqual(editContextMenuTemplate({ isEditable: false, selectionText: "  ", editFlags: flags }, "en"), []);
});

test("the context-menu event pops the menu only when there is something to show", () => {
  const contents = new EventEmitter();
  const shown = [];
  attachEditContextMenu(contents, () => "en", (template) => shown.push(template.map(item => item.role ?? item.type)));
  contents.emit("context-menu", {}, { isEditable: true, selectionText: "", editFlags: flags });
  contents.emit("context-menu", {}, { isEditable: false, selectionText: "", editFlags: flags });
  assert.deepEqual(shown, [["cut", "copy", "paste", "separator", "selectAll"]]);
});
