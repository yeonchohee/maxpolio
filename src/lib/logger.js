import fs from "node:fs";
import { LOG_DIR, LOG_PATH } from "./paths.js";

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, message, context) {
  try {
    ensureLogDir();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(context ? { context } : {}),
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Logging must never throw and take down the caller.
  }
}

export const logger = {
  info: (message, context) => write("info", message, context),
  warn: (message, context) => write("warn", message, context),
  error: (message, context) => {
    const ctx =
      context instanceof Error
        ? { error: context.message, stack: context.stack }
        : context && context.error instanceof Error
          ? { ...context, error: context.error.message, stack: context.error.stack }
          : context;
    write("error", message, ctx);
  },
};
