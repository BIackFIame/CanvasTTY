import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, shell } from "electron";
import electronUpdater from "electron-updater";

// electron-updater 6.8.9 starts NSIS asynchronously but quits before launch errors settle.
// Keep its download/signature verification, and await the installer handoff before quitting.
export class AwaitedNsisUpdater extends electronUpdater.NsisUpdater {
  async installAndRestart(): Promise<void> {
    const installer = this.installerPath;
    const download = this.downloadedUpdateHelper;
    if (!installer || !download?.downloadedFileInfo) throw new Error("No verified update installer");
    const args = ["--updated", "--force-run"];
    if (this.installDirectory) args.push(`/D=${this.installDirectory}`);
    if (download.packageFile) args.push(`--package-file=${download.packageFile}`);
    const elevate = (): Promise<void> => launchInstaller(join(process.resourcesPath, "elevate.exe"), [installer, ...args]);
    if (download.downloadedFileInfo.isAdminRightsRequired) await elevate();
    else {
      try { await launchInstaller(installer, args); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "UNKNOWN") await elevate();
        else if (code === "ENOENT") {
          const failure = await shell.openPath(installer);
          if (failure) throw new Error(failure);
        } else throw error;
      }
    }
    app.quit();
  }
}

function launchInstaller(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
