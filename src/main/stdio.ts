// A desktop app can outlive the launcher that reads its output pipes.
export function handleStdioError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}

process.stdout.on("error", handleStdioError);
process.stderr.on("error", handleStdioError);
