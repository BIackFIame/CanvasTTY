import { app, type BrowserWindow } from "electron";
import { arch, release } from "node:os";
import { DIAGNOSTIC_IMAGE_MAX_BYTES, IPC, type DiagnosticAttachment, type DiagnosticConfiguration, type DiagnosticReportReceipt } from "../../shared/contracts";
import type { IpcRegistrar } from "./IpcReadinessGate";
import type { DiagnosticLog } from "../services/DiagnosticLog";

function validateAttachment(value: unknown): DiagnosticAttachment | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid diagnostic image");
  const image = value as Partial<DiagnosticAttachment>;
  if ((image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") || typeof image.base64 !== "string"
    || image.base64.length > Math.ceil(DIAGNOSTIC_IMAGE_MAX_BYTES / 3) * 4) throw new Error("Invalid diagnostic image");
  const bytes = Buffer.from(image.base64, "base64");
  const signature = image.mimeType === "image/png" ? Buffer.from("89504e470d0a1a0a", "hex") : Buffer.from("ffd8ff", "hex");
  if (bytes.length > DIAGNOSTIC_IMAGE_MAX_BYTES || bytes.toString("base64") !== image.base64
    || !bytes.subarray(0, signature.length).equals(signature)) throw new Error("Invalid diagnostic image");
  return { mimeType: image.mimeType, base64: image.base64 };
}

export function registerDiagnosticIpc(ipc: IpcRegistrar, log: DiagnosticLog,
  getWindow: () => BrowserWindow | null, endpoint: string, context: () => unknown): void {
  let url: URL | null = null;
  try {
    const candidate = new URL(endpoint);
    const local = !app.isPackaged && ["127.0.0.1", "localhost", "[::1]"].includes(candidate.hostname);
    if ((candidate.protocol === "https:" || (candidate.protocol === "http:" && local)) && !candidate.username && !candidate.password
      && !candidate.search && !candidate.hash) url = candidate;
  } catch { /* An unconfigured collector does not block startup. */ }
  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
    const window = getWindow();
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame);
  };
  const assertTrusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!trusted(event)) throw new Error("Diagnostics are available only to the CanvasTTY window");
  };
  ipc.handle(IPC.diagnosticsConfiguration, (event): DiagnosticConfiguration => {
    assertTrusted(event);
    return { available: url !== null, host: url?.host ?? null };
  });
  let sending = false;
  ipc.handle(IPC.diagnosticsSend, async (event, description: unknown, image: unknown): Promise<DiagnosticReportReceipt> => {
    assertTrusted(event);
    if (!url) throw new Error("The diagnostic report server is not configured");
    if (sending) throw new Error("A diagnostic report is already being sent");
    if (typeof description !== "string" || description.trim().length < 5 || description.length > 8000) {
      throw new Error("Describe the problem using 5–8000 characters");
    }
    sending = true;
    try {
      const attachment = validateAttachment(image);
      const report = await log.report(description.trim(), { appVersion: app.getVersion(), platform: process.platform,
        architecture: arch(), osRelease: release(), electron: process.versions.electron,
        node: process.versions.node, chrome: process.versions.chrome, packaged: app.isPackaged, workspace: context() }, attachment);
      if (report.body.byteLength > 5 * 1024 * 1024) throw new Error("DIAGNOSTIC_REPORT_TOO_LARGE");
      const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "X-CanvasTTY-Report-Version": "1" },
        body: new Uint8Array(report.body) });
      if (response.status === 413) throw new Error("DIAGNOSTIC_REPORT_TOO_LARGE");
      if (!response.ok) throw new Error(`Diagnostic report submission failed (HTTP ${response.status})`);
      // The collector acknowledges only the identifier it accepted; no arbitrary server text enters the UI.
      if (!response.body) throw new Error("Empty diagnostic server response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 8192) throw new Error("Invalid diagnostic server response");
        chunks.push(chunk);
      }
      const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!receipt || typeof receipt !== "object" || (receipt as Partial<DiagnosticReportReceipt>).reportId !== report.reportId) {
        throw new Error("The diagnostic server did not acknowledge this report");
      }
      log.record("info", "diagnostics", "report.sent", { reportId: report.reportId });
      return { reportId: report.reportId };
    } catch (error) {
      log.record("error", "diagnostics", "report.failed", error);
      throw new Error(error instanceof Error && error.message === "DIAGNOSTIC_REPORT_TOO_LARGE"
        ? "DIAGNOSTIC_REPORT_TOO_LARGE" : "Could not send the report. Check your connection and try again.");
    } finally { sending = false; }
  });
  let errorWindow = Date.now();
  let errorCount = 0;
  ipc.on(IPC.diagnosticsRendererError, (event, value: unknown) => {
    if (!trusted(event) || !value || typeof value !== "object") return;
    if (Date.now() - errorWindow > 60_000) { errorWindow = Date.now(); errorCount = 0; }
    if (++errorCount > 30) return;
    const error = value as Record<string, unknown>;
    if (!["render", "window", "unhandled-rejection"].includes(String(error.kind)) || typeof error.message !== "string") return;
    log.record("error", "renderer", String(error.kind), {
      message: error.message.slice(0, 4096),
      stack: typeof error.stack === "string" ? error.stack.slice(0, 8192) : undefined,
      componentStack: typeof error.componentStack === "string" ? error.componentStack.slice(0, 8192) : undefined
    });
  });
}
