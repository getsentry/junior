import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RULE = "junior/restricted-call";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OXLINT = path.join(REPO_ROOT, "node_modules/.bin/oxlint");
const DIRECTIVE =
  /\/[/*]\s*(?:oxlint|eslint)-disable(-next-line|-line)?\s([^\n]*?)(?:\*\/|$)/gm;
const run = promisify(execFile);

// Each `junior/restricted-call` setting in the config, with the globs of the
// override that sets it.
function readSettings(root) {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, ".oxlintrc.json"), "utf8"),
  );
  return [{ rules: config.rules }, ...(config.overrides ?? [])]
    .filter((block) => block.rules?.[RULE])
    .map((block) => ({
      files: block.files ?? ["**/*"],
      options: block.rules[RULE][1],
    }));
}

// Lint one file with one `allow` owner removed. Any finding means the owner
// still exempts a use.
async function exemptsUse(root, pluginPath, options, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-call-"));
  const config = path.join(dir, ".oxlintrc.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      plugins: [],
      jsPlugins: [{ name: "junior", specifier: pluginPath }],
      rules: { [RULE]: ["error", options] },
    }),
  );
  try {
    await run(OXLINT, ["-c", config, "--format=unix", file], { cwd: root });
    return false;
  } catch (error) {
    if (!String(error.stdout).includes("junior(restricted-call)")) throw error;
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkOwners(root, pluginPath, options) {
  const checks = options.entries.flatMap((entry, index) =>
    entry.allow.map(async (owner) => {
      if (!fs.existsSync(path.join(root, owner.file))) {
        return `${owner.file} is an \`allow\` owner, but the file does not exist.`;
      }
      const entries = options.entries.map((other, otherIndex) =>
        otherIndex === index
          ? {
              ...other,
              allow: other.allow.filter((kept) => kept !== owner),
            }
          : other,
      );
      const used = await exemptsUse(
        root,
        pluginPath,
        { ...options, entries },
        owner.file,
      );
      return used
        ? null
        : `${owner.file} is an \`allow\` owner, but it exempts no use.`;
    }),
  );
  return (await Promise.all(checks)).filter(Boolean);
}

// A disable must cover one use and say why the code cannot comply. Oxlint
// cannot report this itself: a file-wide disable also hides that report.
function checkDisables(root, files) {
  return fs
    .globSync(files, { cwd: root })
    .sort()
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      return [...source.matchAll(DIRECTIVE)]
        .filter(([, , rules]) => rules.includes(RULE))
        .filter(
          ([, kind, rules]) =>
            kind !== "-next-line" || !/\s--\s*\S/.test(rules),
        )
        .map((match) => {
          const line = source.slice(0, match.index).split("\n").length;
          return `${file}:${line}: disables ${RULE} without \`-next-line\` and a \` -- <reason>\`.`;
        });
    });
}

/**
 * Report `junior/restricted-call` exceptions that are stale or unexplained:
 * `allow` owners that exempt no use, and disables that cover more than one
 * line or give no reason.
 */
export async function checkRestrictedCallExceptions(
  root,
  pluginPath = path.join(root, "tools/oxlint/junior/index.ts"),
) {
  const results = await Promise.all(
    readSettings(root).map(async ({ files, options }) => [
      ...(await checkOwners(root, pluginPath, options)),
      ...checkDisables(root, files),
    ]),
  );
  return results.flat();
}

async function main() {
  const errors = await checkRestrictedCallExceptions(REPO_ROOT);
  if (errors.length === 0) {
    console.log(`Every ${RULE} exception is used and explained.`);
    return;
  }
  console.error(
    [
      `${RULE} exceptions check failed:`,
      ...errors,
      "Delete a stale owner. An owner is a file that owns the boundary. Fix the code so it uses the owner, or put `// oxlint-disable-next-line junior/restricted-call -- <reason>` on the line before the one use that cannot comply.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
