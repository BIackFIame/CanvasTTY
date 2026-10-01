import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type { MaterialsAddResult, Point } from "../../shared/contracts.ts";
import { IPC } from "../../shared/contracts.ts";
import type { MaterialService } from "../services/materials/MaterialService";
import { fileUrlPaths, plistPaths, textPaths, windowsFileNames } from "../services/materials/materialClipboard.ts";
import { isId } from "../services/materials/materialState.ts";
import { assertMainRenderer } from "./registerIpc";

const MAX_CLIPBOARD_PATHS = 16;

interface MaterialIpcDependencies {
  materials: MaterialService;
  getMainWindow(): BrowserWindow | null;
}

export function registerMaterialIpc({ materials, getMainWindow }: MaterialIpcDependencies): void {
  const trusted = (event: IpcMainInvokeEvent): void => assertMainRenderer(event, getMainWindow);

  ipcMain.handle(IPC.materialsSnapshot, (event) => {
    trusted(event);
    return materials.snapshot();
  });

  ipcMain.handle(IPC.materialsAddPaths, (event, paths: unknown, point: unknown) => {
    trusted(event);
    if (!Array.isArray(paths)) throw new Error("File paths are required.");
    return materials.addPaths(paths, point);
  });

  ipcMain.handle(IPC.materialsPick, async (event, point: unknown) => {
    trusted(event);
    const paths = await pickFiles(event, true);
    return paths.length === 0 ? emptyResult() : materials.addPaths(paths, point);
  });

  ipcMain.handle(IPC.materialsPaste, (event, point: unknown) => {
    trusted(event);
    return pasteFromClipboard(materials, point);
  });

  ipcMain.on(IPC.materialsSetBounds, (event, id: unknown, bounds: unknown) => {
    try {
      assertMainRenderer(event, getMainWindow);
    } catch {
      return;
    }
    if (typeof id === "string") materials.setBounds(id, bounds);
  });

  ipcMain.on(IPC.materialsSetBoundsBatch, (event, entries: unknown) => {
    try {
      assertMainRenderer(event, getMainWindow);
    } catch {
      return;
    }
    if (Array.isArray(entries)) materials.setBoundsBatch(entries);
  });

  ipcMain.handle(IPC.materialsRemove, (event, id: unknown) => {
    trusted(event);
    return materials.remove(requireId(id));
  });

  ipcMain.handle(IPC.materialsReveal, (event, id: unknown) => {
    trusted(event);
    const location = materials.location(requireId(id));
    if (location) shell.showItemInFolder(location);
  });

  ipcMain.handle(IPC.materialsRelink, async (event, id: unknown) => {
    trusted(event);
    const materialId = requireId(id);
    const [path] = await pickFiles(event, false);
    return path ? materials.relink(materialId, path) : { ok: false, reason: "cancelled" };
  });

  ipcMain.handle(IPC.materialsAcceptMove, (event, id: unknown) => {
    trusted(event);
    return materials.acceptMove(requireId(id));
  });
}

async function pickFiles(event: IpcMainInvokeEvent, multiple: boolean): Promise<string[]> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"]
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

async function pasteFromClipboard(materials: MaterialService, point: unknown): Promise<MaterialsAddResult> {
  const paths = clipboardPaths();
  if (paths.length > 0) return materials.addPaths(paths, point);
  if (!clipboard.readImage().isEmpty()) {
    return { added: [], existing: [], rejected: [{ name: "clipboard", reason: "empty-clipboard" }] };
  }
  return { added: [], existing: [], rejected: [{ name: "clipboard", reason: "empty-clipboard" }] };
}

function clipboardPaths(): string[] {
  const listed = process.platform === "darwin"
    ? orElse(plistPaths(safeRead(() => clipboard.read("NSFilenamesPboardType"))), () => fileUrlPaths(safeRead(() => clipboard.read("public.file-url"))))
    : process.platform === "win32"
      ? windowsFileNames(safeRead(() => clipboard.readBuffer("FileNameW"), Buffer.alloc(0)))
      : fileUrlPaths(safeRead(() => clipboard.read("text/uri-list")));
  return listed.length > 0 ? listed : textPaths(safeRead(() => clipboard.readText()), process.platform);
}

function orElse(paths: string[], fallback: () => string[]): string[] {
  return paths.length > 0 ? paths : fallback();
}

function safeRead<T = string>(read: () => T, fallback = "" as T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

function requireId(value: unknown): string {
  if (!isId(value)) throw new Error("Material id is required.");
  return value;
}

function emptyResult(): MaterialsAddResult {
  return { added: [], existing: [], rejected: [] };
}
