import os from "node:os";
import path from "node:path";

export const MAXPOLIO_HOME = path.join(os.homedir(), ".maxpolio");
export const CONFIG_PATH = path.join(MAXPOLIO_HOME, "config.json");
export const CATEGORIES_PATH = path.join(MAXPOLIO_HOME, "categories.json");
export const LOG_DIR = path.join(MAXPOLIO_HOME, "logs");
export const LOG_PATH = path.join(LOG_DIR, "maxpolio.log");

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
