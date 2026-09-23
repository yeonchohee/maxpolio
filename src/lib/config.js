import fs from "node:fs";
import { CONFIG_PATH, MAXPOLIO_HOME, expandHome } from "./paths.js";
import { logger } from "./logger.js";

const DEFAULT_CONFIG = {
  outputDir: "~/maxpolio-journal",
  // Runs through the locally logged-in Claude Code CLI (subscription usage,
  // no separate API key). See src/lib/claude-cli.js.
  model: "sonnet",
};

export function loadConfig() {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    logger.info("created default config", { path: CONFIG_PATH });
  }

  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    logger.error("failed to parse config.json, falling back to defaults", { error: err, path: CONFIG_PATH });
  }

  const merged = { ...DEFAULT_CONFIG, ...userConfig };

  merged.outputDir = expandHome(merged.outputDir);
  return merged;
}
