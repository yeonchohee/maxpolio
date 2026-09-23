import { runPipeline } from "./pipeline.js";
import { logger } from "./lib/logger.js";

const [, , sessionId, transcriptPath, cwd] = process.argv;

if (!sessionId || !transcriptPath) {
  logger.error("worker invoked without required args", { argv: process.argv });
  process.exit(0);
}

runPipeline({ sessionId, transcriptPath, cwd })
  .catch((err) => logger.error("unhandled worker error", { error: err }))
  .finally(() => process.exit(0));
