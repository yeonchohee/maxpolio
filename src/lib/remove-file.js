import fs from "node:fs";

/**
 * Deletes a file, ignoring "already gone". Use this instead of
 * fs.rmSync(p, { force: true }): on Windows, Node 24's rmSync hard-crashes
 * the process (exit 127, no exception) when the path contains non-ASCII
 * characters, which every Korean-titled note does.
 */
export function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
