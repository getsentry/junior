import os from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

// Run publint on each package directory given as an argument:
// `node scripts/package-lint.mjs packages/junior packages/junior-github`.
// Each run packs its package with `pnpm pack`, and starting pnpm takes most
// of that time, so the packages run in parallel in one process.

const packageDirs = process.argv.slice(2);
const results = await pLimit(os.availableParallelism()).map(
  packageDirs,
  (packageDir) => publint({ pkgDir: path.resolve(packageDir), pack: "pnpm" }),
);
let failed = false;
for (const [index, { messages, pkg }] of results.entries()) {
  if (messages.length === 0) continue;
  console.log(`publint ${packageDirs[index]}:`);
  for (const message of messages) {
    failed ||= message.type === "error";
    console.log(`  ${message.type}: ${formatMessage(message, pkg)}`);
  }
}
process.exitCode = failed ? 1 : 0;
