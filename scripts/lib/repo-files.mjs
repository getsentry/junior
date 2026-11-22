import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";

// Enough reads in flight to overlap file I/O, few enough to stay under the
// open file limit.
const READ_CONCURRENCY = 64;

/**
 * List the repo files that exist in the working tree, tracked or new, minus
 * git-ignored files. Paths are relative to `root` and use `/`.
 */
export function listRepoFiles(root) {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => file && fs.existsSync(path.join(root, file)));
  // A file with merge conflicts is listed once per stage.
  return [...new Set(files)].sort();
}

/** Read each listed file as `{ path, contents }`, keeping the order. */
export function readRepoFiles(root, files) {
  return pLimit(READ_CONCURRENCY).map(files, async (file) => ({
    path: file,
    contents: await fs.promises.readFile(path.join(root, file), "utf8"),
  }));
}
