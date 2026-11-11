export class SessionFileTooLargeError extends Error {
  readonly code = "session_file_too_large" as const;
  constructor(filePath: string) {
    super(`Session file is too large to open in omp-web: ${filePath}`);
    this.name = "SessionFileTooLargeError";
  }
}

export class SessionHistoryWorkerError extends Error {
  constructor(readonly code: "session_history_busy" | "session_history_worker_failed") {
    super(code === "session_history_busy" ? "Session history reader is busy" : "Session history worker failed");
    this.name = "SessionHistoryWorkerError";
  }
}
