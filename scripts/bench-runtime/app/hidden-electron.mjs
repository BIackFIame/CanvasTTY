// Benchmark harness: the app's own `electron` import, with every window created hidden, off-screen and
// unfocusable, native dialogs and shell calls answered locally, and safeStorage off (a real call would ask
// the keychain). terminal:data bytes sent to the renderer are counted for the report.
export * from "electron";
import { BrowserWindow as Base, dialog as realDialog, shell as realShell } from "electron";

globalThis.__benchIpc = { terminalDataBytes: 0 };
export class BrowserWindow extends Base {
  constructor(options = {}) {
    super({ ...options, show: false, x: -32000, y: -32000, focusable: false, paintWhenInitiallyHidden: true });
    const contents = this.webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel === "terminal:data" && typeof args[0]?.data === "string") globalThis.__benchIpc.terminalDataBytes += args[0].data.length;
      // Builds that send each output flush as one batch message.
      if (channel === "terminal:data-batch" && Array.isArray(args[0])) {
        for (const event of args[0]) if (typeof event?.data === "string") globalThis.__benchIpc.terminalDataBytes += event.data.length;
      }
      return send(channel, ...args);
    };
  }
  show() {}
  showInactive() {}
  focus() {}
  moveTop() {}
  maximize() {}
  setFullScreen() {}
}
export const dialog = {
  ...realDialog,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showErrorBox: () => undefined
};
export const shell = {
  ...realShell,
  openExternal: async () => undefined,
  openPath: async () => "",
  showItemInFolder: () => undefined
};
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "basic_text",
  encryptString: () => { throw new Error("safeStorage is off in the benchmark"); },
  decryptString: () => { throw new Error("safeStorage is off in the benchmark"); }
};
globalThis.__benchHiddenShim = true;
