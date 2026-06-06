#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const includeFileNames = ["scripts/worktree.include", ".worktreeinclude"];

function usage() {
  console.log(`Usage:
  pnpm worktree list
  pnpm worktree new <branch> [--from <ref>] [--path <path>] [--no-install] [--open <command>] [--agent <command>]
  pnpm worktree setup [path] [--source <path>] [--no-install]
  pnpm worktree exec <worktree> -- <command>
  pnpm worktree remove <worktree>

Examples:
  pnpm worktree new codex/fix-slack-retry --open "code ."
  pnpm worktree new codex/fix-ci --agent "codex"
  pnpm worktree exec codex/fix-ci -- pnpm test
  pnpm worktree remove codex/fix-ci
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function formatCommand(args) {
  return args
    .map((arg) => {
      if (/^[A-Za-z0-9_/:=@%.,+-]+$/.test(arg)) {
        return arg;
      }

      return JSON.stringify(arg);
    })
    .join(" ");
}

function runRequired(command, args, options = {}) {
  const { exitOnFailure = true, ...spawnOptions } = options;
  let result;

  try {
    result = run(command, args, { stdio: "inherit", ...spawnOptions });
  } catch (error) {
    const message = `Failed to run ${formatCommand([command, ...args])}: ${
      error instanceof Error ? error.message : String(error)
    }`;

    if (!exitOnFailure) {
      throw new Error(message);
    }

    fail(message);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return result;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    if (!exitOnFailure) {
      throw new Error(
        `${formatCommand([command, ...args])} exited with status ${result.status}`,
      );
    }

    process.exit(result.status);
  }

  return result;
}

function readRequired(command, args, options = {}) {
  const result = run(command, args, options);

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `${command} ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function git(args, options = {}) {
  return run("git", args, { cwd: workspaceRoot, ...options });
}

function readGit(args) {
  return readRequired("git", args, { cwd: workspaceRoot });
}

function currentRepositoryRoot() {
  return readGit(["rev-parse", "--show-toplevel"]);
}

function commonGitDir() {
  return readGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

function mainCheckoutRoot() {
  const commonDir = commonGitDir();

  if (path.basename(commonDir) === ".git") {
    return path.dirname(commonDir);
  }

  return currentRepositoryRoot();
}

function defaultCopySourceRoot() {
  return mainCheckoutRoot();
}

function copySourceRoot(options) {
  return path.resolve(
    options.source ??
      process.env.JUNIOR_WORKTREE_SOURCE ??
      defaultCopySourceRoot(),
  );
}

function gitConfigValue(key) {
  const result = git(["config", "--get", key]);

  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function defaultWorktreeParent() {
  const configured =
    process.env.JUNIOR_WORKTREE_DIR ?? gitConfigValue("junior.worktreeDir");
  const mainRoot = mainCheckoutRoot();

  if (configured?.trim()) {
    return path.resolve(mainRoot, configured.trim());
  }

  return path.join(
    path.dirname(mainRoot),
    `${path.basename(mainRoot)}-worktrees`,
  );
}

function sanitizePathSegment(value) {
  return normalizeBranchName(value)
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeBranchName(value) {
  return value.replace(/^refs\/heads\//, "");
}

function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function worktreePathSegment(branch) {
  const sanitized = sanitizePathSegment(branch) || "branch";
  return `${sanitized}-${shortHash(branch)}`;
}

function comparablePath(value) {
  const resolved = path.resolve(value);

  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function branchExists(branch) {
  return (
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status ===
    0
  );
}

function refExists(ref) {
  return git(["rev-parse", "--verify", "--quiet", ref]).status === 0;
}

function defaultBaseRef() {
  const configured =
    process.env.JUNIOR_WORKTREE_BASE ?? gitConfigValue("junior.worktreeBase");

  if (configured?.trim()) {
    return configured;
  }

  if (refExists("origin/main")) {
    return "origin/main";
  }
  if (refExists("main")) {
    return "main";
  }

  return "HEAD";
}

function parseWorktreeList() {
  const output = readGit(["worktree", "list", "--porcelain"]);
  const records = output
    .split(/\n\s*\n/)
    .map((record) => record.trim())
    .filter(Boolean);

  return records.map((record) => {
    const entry = {};

    for (const line of record.split("\n")) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");

      if (key === "worktree") {
        entry.path = value;
      } else if (key === "HEAD") {
        entry.head = value;
      } else if (key === "branch") {
        entry.branch = value.replace(/^refs\/heads\//, "");
      } else if (key === "detached") {
        entry.detached = true;
      } else if (key === "bare") {
        entry.bare = true;
      } else if (key === "locked") {
        entry.locked = value || true;
      } else if (key === "prunable") {
        entry.prunable = value || true;
      }
    }

    return entry;
  });
}

function findWorktree(identifier) {
  const resolvedIdentifier = comparablePath(identifier);
  const normalizedIdentifier = normalizeBranchName(identifier);
  const matches = parseWorktreeList().filter((entry) => {
    const entryPath = comparablePath(entry.path);

    if (
      entryPath === resolvedIdentifier ||
      entry.path === identifier ||
      path.resolve(entry.path) === path.resolve(identifier)
    ) {
      return true;
    }

    if (entry.branch === normalizedIdentifier) {
      return true;
    }

    return (
      path.basename(entry.path) === worktreePathSegment(normalizedIdentifier)
    );
  });

  if (matches.length === 0) {
    fail(`No worktree found for "${identifier}".`);
  }
  if (matches.length > 1) {
    fail(
      `Multiple worktrees match "${identifier}":\n${matches
        .map((entry) => `  ${entry.path}`)
        .join("\n")}`,
    );
  }

  return matches[0];
}

function splitOptions(args) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      positional.push(...args.slice(index));
      break;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const optionText = arg.slice(2);
    const equalsIndex = optionText.indexOf("=");
    const name =
      equalsIndex === -1 ? optionText : optionText.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : optionText.slice(equalsIndex + 1);
    const booleanName = name.startsWith("no-") ? name.slice(3) : name;
    const takesValue = ["agent", "from", "open", "path", "source"].includes(
      name,
    );

    if (name.startsWith("no-")) {
      options[booleanName] = false;
      continue;
    }

    if (takesValue) {
      const value = inlineValue ?? args[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`Missing value for --${name}.`);
      }
      options[name] = value;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    options[name] = true;
  }

  return { options, positional };
}

function resolveIncludePath(sourceRoot) {
  for (const relativePath of includeFileNames) {
    const includePath = path.join(sourceRoot, relativePath);

    if (
      fs.existsSync(includePath) &&
      !fs.lstatSync(includePath).isSymbolicLink()
    ) {
      return includePath;
    }
  }

  return null;
}

function readIncludePatterns(sourceRoot) {
  const sourceIncludePath = resolveIncludePath(sourceRoot);
  const workspaceIncludePath =
    sourceRoot === workspaceRoot ? null : resolveIncludePath(workspaceRoot);
  const includePath = sourceIncludePath ?? workspaceIncludePath;
  const includeRoot = sourceIncludePath ? sourceRoot : workspaceRoot;

  if (!includePath) {
    return { patterns: [], source: null };
  }

  const patterns = fs
    .readFileSync(includePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return {
    patterns,
    source: path.relative(includeRoot, includePath),
  };
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  let regex = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char);
    }
  }

  regex += "$";
  return new RegExp(regex);
}

function walkFiles(root) {
  const files = [];
  const stack = [""];

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = path.join(root, relativeDir);

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const relativePath = path.join(relativeDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replace(/\\/g, "/"));
      }
    }
  }

  return files;
}

function includedFiles(sourceRoot, patterns) {
  const exactFiles = [];
  const regexes = [];

  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      regexes.push(globToRegex(pattern));
      continue;
    }

    const absolutePath = path.join(sourceRoot, pattern);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isDirectory()) {
      regexes.push(globToRegex(`${pattern.replace(/\/+$/, "")}/**`));
    } else {
      exactFiles.push(pattern);
    }
  }

  const matchedFiles = regexes.length
    ? walkFiles(sourceRoot).filter((file) =>
        regexes.some((regex) => regex.test(file)),
      )
    : [];

  return [...new Set([...exactFiles, ...matchedFiles])].sort();
}

function copyIncludedFiles(sourceRoot, targetRoot) {
  const { patterns, source } = readIncludePatterns(sourceRoot);

  if (patterns.length === 0) {
    console.log(
      `No worktree include patterns found. Checked: ${includeFileNames.join(", ")}.`,
    );
    return { copied: 0, matched: 0, source: null };
  }

  const files = includedFiles(sourceRoot, patterns);

  if (files.length === 0) {
    console.log(`${source} matched no local files in ${sourceRoot}.`);
    return { copied: 0, matched: 0, source };
  }

  let copied = 0;

  for (const relativePath of files) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);

    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, {
      dereference: false,
      force: true,
      preserveTimestamps: true,
      recursive: true,
    });
    copied += 1;
  }

  console.log(
    `Copied ${copied} local file${copied === 1 ? "" : "s"} from ${sourceRoot}.`,
  );
  return { copied, matched: files.length, source };
}

function installDependencies(targetRoot, options = {}) {
  if (!fs.existsSync(path.join(targetRoot, "pnpm-lock.yaml"))) {
    console.log("No pnpm-lock.yaml found; skipping dependency install.");
    return;
  }

  console.log("Installing dependencies with pnpm install...");
  runRequired("pnpm", ["install"], {
    cwd: targetRoot,
    exitOnFailure: options.exitOnFailure,
  });
}

function runShellCommand(command, cwd) {
  console.log(`Running in ${cwd}: ${command}`);
  runRequired(command, [], {
    cwd,
    shell: true,
    stdio: "inherit",
  });
}

function runDirectCommand(args, cwd) {
  const [command, ...commandArgs] = args;

  console.log(`Running in ${cwd}: ${formatCommand(args)}`);
  runRequired(command, commandArgs, {
    cwd,
    stdio: "inherit",
  });
}

function setupWorktree(args) {
  const { options, positional } = splitOptions(args);
  const targetRoot = path.resolve(positional[0] ?? process.cwd());
  const sourceRoot = copySourceRoot(options);

  copyIncludedFiles(sourceRoot, targetRoot);

  if (options.install !== false) {
    installDependencies(targetRoot);
  }
}

function setupCreatedWorktree(targetRoot, sourceRoot, shouldInstall) {
  copyIncludedFiles(sourceRoot, targetRoot);

  if (shouldInstall) {
    installDependencies(targetRoot, { exitOnFailure: false });
  }
}

function listWorktrees() {
  const entries = parseWorktreeList();
  const currentRoot = comparablePath(currentRepositoryRoot());

  for (const entry of entries) {
    const label = entry.branch ?? "(detached)";
    const marker = comparablePath(entry.path) === currentRoot ? "*" : " ";
    const flags = [
      entry.bare ? "bare" : null,
      entry.locked ? "locked" : null,
      entry.prunable ? "prunable" : null,
    ].filter(Boolean);

    console.log(
      `${marker} ${label.padEnd(36)} ${entry.path}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
    );
  }
}

function createWorktree(args) {
  const { options, positional } = splitOptions(args);
  const rawBranch = positional[0];
  const branch = rawBranch ? normalizeBranchName(rawBranch) : null;

  if (!branch) {
    fail("Missing branch name.");
  }

  const targetRoot = path.resolve(
    options.path ??
      path.join(defaultWorktreeParent(), worktreePathSegment(branch)),
  );
  const existingBranch = branchExists(branch);

  if (existingBranch && options.from) {
    fail(
      `Branch "${branch}" already exists; --from only applies when creating a new branch.`,
    );
  }

  const baseRef = existingBranch ? null : (options.from ?? defaultBaseRef());
  const addArgs = existingBranch
    ? ["worktree", "add", targetRoot, branch]
    : ["worktree", "add", "-b", branch, targetRoot, baseRef];

  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  runRequired("git", addArgs, { cwd: workspaceRoot });

  try {
    setupCreatedWorktree(
      targetRoot,
      copySourceRoot(options),
      options.install !== false,
    );
  } catch (error) {
    console.error(
      `Setup failed; removing incomplete worktree at ${targetRoot}.`,
    );
    const removeResult = git(["worktree", "remove", "--force", targetRoot], {
      stdio: "inherit",
    });

    if (removeResult.status !== 0) {
      console.error(
        `Unable to remove incomplete worktree automatically. Run: git worktree remove --force ${JSON.stringify(targetRoot)}`,
      );
    } else if (!existingBranch) {
      const deleteResult = git(["branch", "-D", branch], {
        stdio: "inherit",
      });

      if (deleteResult.status !== 0) {
        console.error(
          `Unable to delete newly-created branch automatically. Run: git branch -D ${JSON.stringify(branch)}`,
        );
      }
    }

    fail(error instanceof Error ? error.message : String(error));
  }

  console.log(`Worktree ready: ${targetRoot}`);
  console.log(`Branch: ${branch}`);
  if (baseRef) {
    console.log(`Base: ${baseRef}`);
  } else {
    console.log("Base: existing branch tip");
  }

  if (options.open) {
    runShellCommand(options.open, targetRoot);
  }
  if (options.agent) {
    runShellCommand(options.agent, targetRoot);
  }
}

function execInWorktree(args) {
  const separatorIndex = args.indexOf("--");
  const target = args[0];

  if (!target) {
    fail("Missing worktree name.");
  }
  if (separatorIndex === -1 || separatorIndex === args.length - 1) {
    fail("Missing command. Use: pnpm worktree exec <worktree> -- <command>");
  }

  const entry = findWorktree(target);
  runDirectCommand(args.slice(separatorIndex + 1), entry.path);
}

function removeWorktree(args) {
  const { positional } = splitOptions(args);
  const target = positional[0];

  if (!target) {
    fail("Missing worktree name.");
  }

  const entry = findWorktree(target);
  const entryPath = comparablePath(entry.path);
  const currentRoot = comparablePath(currentRepositoryRoot());
  const mainRoot = comparablePath(mainCheckoutRoot());

  if (entryPath === currentRoot) {
    fail("Refusing to remove the worktree running this helper.");
  }
  if (entryPath === mainRoot) {
    fail("Refusing to remove the main checkout.");
  }

  runRequired("git", ["worktree", "remove", entry.path], {
    cwd: workspaceRoot,
  });
  console.log(`Removed worktree: ${entry.path}`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  case "list":
  case "ls":
    listWorktrees();
    break;
  case "new":
  case "create":
    createWorktree(args);
    break;
  case "setup":
    setupWorktree(args);
    break;
  case "exec":
  case "run":
    execInWorktree(args);
    break;
  case "remove":
  case "rm":
    removeWorktree(args);
    break;
  default:
    fail(`Unknown worktree command: ${command}`);
}
