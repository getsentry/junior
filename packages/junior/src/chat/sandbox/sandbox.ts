import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import { extractHttpErrorDetails } from "@/chat/sandbox/http-error-details";
import {
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import {
  SANDBOX_SKILLS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  sandboxSkillDir,
} from "@/chat/sandbox/paths";
import {
  buildNonInteractiveShellScript,
  runNonInteractiveCommand,
} from "@/chat/sandbox/noninteractive-command";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  getRuntimeDependencyProfileHash,
  isSnapshotMissingError,
  resolveRuntimeDependencySnapshot,
  type RuntimeDependencySnapshotProgressPhase,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

// Spec: specs/security-policy.md (sandbox isolation, network policy, credential lifecycle)
// Spec: specs/logging/tracing-spec.md (required sandbox span semantics)
interface SandboxExecutionInput {
  toolName: string;
  input: unknown;
}

export interface SandboxExecutionEnvelope<T = unknown> {
  result: T;
}

export interface BashCustomCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number;
  signal: null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface SandboxExecutor {
  configureSkills(skills: SkillMetadata[]): void;
  getSandboxId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  canExecute(toolName: string): boolean;
  createSandbox(): Promise<SandboxWorkspace>;
  execute<T>(
    params: SandboxExecutionInput,
  ): Promise<SandboxExecutionEnvelope<T>>;
  dispose(): Promise<void>;
}

interface ToolExecutors {
  bash: (input: {
    command: string;
    headerTransforms?: Array<{
      domain: string;
      headers: Record<string, string>;
    }>;
    env?: Record<string, string>;
  }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: {
    path: string;
    content: string;
  }) => Promise<{ success: boolean }>;
}

const SANDBOX_TOOL_NAMES = new Set(["bash", "readFile", "writeFile"]);
const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const SANDBOX_RUNTIME = "node22";
const SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
const EVAL_GH_STUB_PATH = `${SANDBOX_RUNTIME_BIN_DIR}/gh`;
const SNAPSHOT_BOOT_RETRY_COUNT = 3;
const SNAPSHOT_BOOT_RETRY_DELAY_MS = 1000;
const SANDBOX_ERROR_FIELDS = [
  {
    sourceKey: "sandboxId",
    attributeKey: "sandbox_id",
    summaryKey: "sandboxId",
  },
] as const;

type NetworkPolicyAllowEntry = Array<{
  transform?: Array<{ headers: Record<string, string> }>;
}>;

function mergeNetworkPolicyWithHeaderTransforms(
  networkPolicy: unknown,
  headerTransforms: Array<{ domain: string; headers: Record<string, string> }>,
): { allow: Record<string, NetworkPolicyAllowEntry> } & Record<
  string,
  unknown
> {
  const basePolicy =
    networkPolicy &&
    typeof networkPolicy === "object" &&
    !Array.isArray(networkPolicy)
      ? ({ ...(networkPolicy as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};

  const existingAllowRaw = basePolicy.allow;
  const existingAllow: Record<string, NetworkPolicyAllowEntry> =
    existingAllowRaw &&
    typeof existingAllowRaw === "object" &&
    !Array.isArray(existingAllowRaw)
      ? Object.fromEntries(
          Object.entries(existingAllowRaw as Record<string, unknown>).map(
            ([domain, rules]) => [
              domain,
              Array.isArray(rules)
                ? ([...rules] as NetworkPolicyAllowEntry)
                : [],
            ],
          ),
        )
      : { "*": [] };

  for (const transform of headerTransforms) {
    const currentRules = existingAllow[transform.domain] ?? [];
    existingAllow[transform.domain] = [
      ...currentRules,
      { transform: [{ headers: transform.headers }] },
    ];
  }

  return {
    ...basePolicy,
    allow: existingAllow,
  };
}

function truncateOutput(
  output: string,
  maxLength: number,
): { value: string; truncated: boolean } {
  if (output.length <= maxLength) {
    return { value: output, truncated: false };
  }
  const truncatedLength = output.length - maxLength;
  return {
    value: `${output.slice(0, maxLength)}\n\n[output truncated: ${truncatedLength} characters removed]`,
    truncated: true,
  };
}

function toPosixRelative(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const queue: string[] = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files;
}

async function buildSkillSyncFiles(
  availableSkills: SkillMetadata[],
): Promise<Array<{ path: string; content: Buffer }>> {
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];
  const index = {
    skills: [] as Array<{
      name: string;
      description: string;
      root: string;
    }>,
  };

  for (const skill of availableSkills) {
    const skillFiles = await listFilesRecursive(skill.skillPath);
    for (const absoluteFile of skillFiles) {
      const relative = toPosixRelative(skill.skillPath, absoluteFile);
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      filesToWrite.push({
        path: `${sandboxSkillDir(skill.name)}/${relative}`,
        content: await fs.readFile(absoluteFile),
      });
    }

    index.skills.push({
      name: skill.name,
      description: skill.description,
      root: sandboxSkillDir(skill.name),
    });
  }

  filesToWrite.push({
    path: `${SANDBOX_SKILLS_ROOT}/index.json`,
    content: Buffer.from(JSON.stringify(index), "utf8"),
  });

  if (process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1") {
    filesToWrite.push({
      path: EVAL_GH_STUB_PATH,
      content: Buffer.from(buildEvalGitHubCliStub(), "utf8"),
    });
  }

  return filesToWrite;
}

function buildEvalGitHubCliStub(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const statePath = "/vercel/sandbox/.junior/eval-gh-state.json";
const fallbackBinaries = ["/usr/bin/gh", "/usr/local/bin/gh", "/bin/gh"];
const flagsWithValues = new Set([
  "--repo",
  "--title",
  "--body",
  "--body-file",
  "--json",
  "--search",
  "--state",
  "--limit",
  "--method",
  "--jq",
  "--template",
  "--hostname",
]);

function getFlag(name) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      return args[index + 1];
    }
    if (value.startsWith(name + "=")) {
      return value.slice(name.length + 1);
    }
  }
  return undefined;
}

function hasFlag(name) {
  return args.includes(name) || args.some((value) => value.startsWith(name + "="));
}

function getPositionals() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--") && value.includes("=")) {
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    values.push(value);
  }
  return values;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { nextIssueNumber: 101, issues: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function issueUrl(repo, number) {
  return "https://github.com/" + repo + "/issues/" + number;
}

function repoValue() {
  return getFlag("--repo") || "getsentry/junior";
}

function readBody() {
  const bodyFile = getFlag("--body-file");
  if (bodyFile) {
    try {
      return fs.readFileSync(bodyFile, "utf8");
    } catch {
      return "";
    }
  }
  return getFlag("--body") || "";
}

function defaultIssue(repo, number) {
  return {
    number,
    title: "Eval issue",
    body: "",
    state: "OPEN",
    url: issueUrl(repo, number),
    labels: [],
    assignees: [],
    author: { login: "junior-eval" },
  };
}

function pickFields(record, csv) {
  if (!csv) {
    return record;
  }
  return Object.fromEntries(
    csv
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((key) => [key, key in record ? record[key] : null]),
  );
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\\n");
}

function fallbackToRealGh() {
  for (const binary of fallbackBinaries) {
    if (!fs.existsSync(binary)) {
      continue;
    }
    const result = spawnSync(binary, args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  process.stderr.write("gh stub: unsupported command\\n");
  process.exit(1);
}

if (args.length === 0 || args[0] === "--version" || args[0] === "version") {
  process.stdout.write("gh version 2.0.0 (junior-eval)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("github.com\\n  ✓ Logged in to github.com as junior-eval\\n");
  process.exit(0);
}

if (args[0] === "search" && args[1] === "issues") {
  const jsonFields = getFlag("--json");
  if (jsonFields) {
    outputJson([]);
  }
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "view") {
  const positionals = getPositionals();
  const repo = positionals[2] || repoValue();
  const record = {
    nameWithOwner: repo,
    url: "https://github.com/" + repo,
    defaultBranchRef: { name: "main" },
  };
  const jsonFields = getFlag("--json");
  if (jsonFields) {
    outputJson(pickFields(record, jsonFields));
  } else {
    process.stdout.write(record.url + "\\n");
  }
  process.exit(0);
}

if (args[0] === "api") {
  const positionals = getPositionals();
  const route = positionals[1] || "";
  if (route.includes("/comments")) {
    outputJson([]);
    process.exit(0);
  }
  if (route.includes("/search/issues")) {
    outputJson({ items: [] });
    process.exit(0);
  }
}

if (args[0] === "issue") {
  const subcommand = args[1];
  const positionals = getPositionals();
  const repo = repoValue();
  const state = loadState();

  if (subcommand === "list") {
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson([]);
    }
    process.exit(0);
  }

  if (subcommand === "create") {
    const number = state.nextIssueNumber++;
    const record = {
      number,
      title: getFlag("--title") || "Eval issue",
      body: readBody(),
      state: "OPEN",
      url: issueUrl(repo, number),
      labels: [],
      assignees: [],
      author: { login: "junior-eval" },
    };
    state.issues[repo + "#" + number] = record;
    saveState(state);
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson(pickFields(record, jsonFields));
    } else {
      process.stdout.write(record.url + "\\n");
    }
    process.exit(0);
  }

  const number = Number.parseInt(positionals[2] || "", 10);
  const key = repo + "#" + number;
  const record = state.issues[key] || defaultIssue(repo, Number.isFinite(number) ? number : 101);

  if (subcommand === "view") {
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson(pickFields(record, jsonFields));
    } else {
      process.stdout.write(record.url + "\\n");
    }
    process.exit(0);
  }

  if (subcommand === "edit") {
    const nextRecord = {
      ...record,
      title: getFlag("--title") || record.title,
      body: readBody() || record.body,
    };
    state.issues[key] = nextRecord;
    saveState(state);
    process.exit(0);
  }

  if (subcommand === "comment") {
    process.stdout.write(record.url + "#issuecomment-1\\n");
    process.exit(0);
  }

  if (subcommand === "close" || subcommand === "reopen") {
    state.issues[key] = {
      ...record,
      state: subcommand === "close" ? "CLOSED" : "OPEN",
    };
    saveState(state);
    process.exit(0);
  }
}

fallbackToRealGh();
`;
}

function collectDirectories(
  filesToWrite: Array<{ path: string; content: Buffer }>,
): string[] {
  const directoriesToEnsure = new Set<string>();
  for (const file of filesToWrite) {
    const normalizedPath = path.posix.normalize(file.path);
    const parts = normalizedPath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;
      directoriesToEnsure.add(current);
    }
  }

  return Array.from(directoriesToEnsure)
    .filter(
      (directory) =>
        directory === SANDBOX_WORKSPACE_ROOT ||
        directory.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`),
    )
    .sort((a, b) => a.length - b.length);
}

function getSandboxErrorDetails(error: unknown) {
  return extractHttpErrorDetails(error, {
    attributePrefix: "app.sandbox.api_error",
    extraFields: [...SANDBOX_ERROR_FIELDS],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  const details = getSandboxErrorDetails(error);
  return (
    details.searchableText.includes("already exists") ||
    details.searchableText.includes("file exists") ||
    details.searchableText.includes("eexist")
  );
}

function findInErrorChain(
  error: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    if (typeof current === "object") {
      current = (current as { cause?: unknown }).cause;
    } else {
      current = undefined;
    }
  }
  return false;
}

function isSandboxUnavailableError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const details = getSandboxErrorDetails(candidate);
    const searchable =
      `${details.searchableText} ${details.summary}`.toLowerCase();
    return (
      searchable.includes("sandbox_stopped") ||
      searchable.includes("status=410") ||
      searchable.includes("status code 410") ||
      searchable.includes("no longer available")
    );
  });
}

function isSnapshottingError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const details = getSandboxErrorDetails(candidate);
    const searchable =
      `${details.searchableText} ${details.summary}`.toLowerCase();
    return (
      searchable.includes("sandbox_snapshotting") ||
      searchable.includes("creating a snapshot") ||
      searchable.includes("stopped shortly")
    );
  });
}

function getFirstErrorMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message) {
        return message;
      }
    }
    seen.add(current);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return undefined;
}

function wrapSandboxSetupError(error: unknown): Error {
  try {
    const details = getSandboxErrorDetails(error);
    if (details.summary) {
      return new Error(`sandbox setup failed (${details.summary})`, {
        cause: error,
      });
    }
  } catch {
    // Keep fallback message below if detail extraction fails.
  }

  let causeMessage: string | undefined;
  try {
    causeMessage = getFirstErrorMessage(error);
  } catch (cause) {
    causeMessage = cause instanceof Error ? cause.message : undefined;
  }

  if (
    causeMessage &&
    causeMessage.trim() &&
    causeMessage !== "sandbox setup failed"
  ) {
    const oneLine = causeMessage.replace(/\s+/g, " ").trim();
    return new Error(`sandbox setup failed (${oneLine})`, { cause: error });
  }

  return new Error("sandbox setup failed", { cause: error });
}

function throwSandboxOperationError(
  action: string,
  error: unknown,
  includeMissingPath = false,
): never {
  const details = getSandboxErrorDetails(error);
  setSpanAttributes({
    ...details.attributes,
    ...(includeMissingPath
      ? {
          "app.sandbox.api_error.missing_path":
            details.searchableText.includes("no such file") ||
            details.searchableText.includes("enoent"),
        }
      : {}),
    "app.sandbox.success": false,
  });
  setSpanStatus("error");
  throw new Error(
    details.summary
      ? `${action} failed (${details.summary})`
      : `${action} failed`,
    {
      cause: error,
    },
  );
}

export function createSandboxExecutor(options?: {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: LogContext;
  onStatus?: (status: string) => void | Promise<void>;
  runBashCustomCommand?: (
    command: string,
  ) => Promise<{ handled: boolean; result?: BashCustomCommandResult }>;
}): SandboxExecutor {
  let sandbox: Sandbox | null = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills: SkillMetadata[] = [];
  let toolExecutors: ToolExecutors | undefined;

  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options?.traceContext ?? {};
  const emitStatus = options?.onStatus;
  const dependencyProfileHash =
    getRuntimeDependencyProfileHash(SANDBOX_RUNTIME);

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  const createSandboxFromSnapshot = async (
    snapshotId: string,
    sandboxCredentials:
      | {
          token?: string;
          teamId?: string;
          projectId?: string;
        }
      | undefined,
    onStatus?: (status: string) => Promise<void>,
  ): Promise<Sandbox> => {
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      try {
        await onStatus?.("Booting up...");
        return await Sandbox.create({
          timeout: timeoutMs,
          source: {
            type: "snapshot",
            snapshotId,
          },
          ...(sandboxCredentials ?? {}),
        });
      } catch (error) {
        if (
          !isSnapshottingError(error) ||
          attempt === SNAPSHOT_BOOT_RETRY_COUNT - 1
        ) {
          throw error;
        }
        await sleep(SNAPSHOT_BOOT_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Failed to boot sandbox from snapshot ${snapshotId}`);
  };

  const invalidateSandboxInstance = async (
    targetSandbox: Sandbox,
    reason: unknown,
  ): Promise<void> => {
    if (sandbox === targetSandbox) {
      sandbox = null;
      sandboxIdHint = undefined;
      toolExecutors = undefined;
    }
    logWarn(
      "sandbox_network_policy_restore_failed",
      traceContext,
      {
        "error.message":
          reason instanceof Error ? reason.message : String(reason),
      },
      "Sandbox network policy restore failed; discarding sandbox instance",
    );
    try {
      await targetSandbox.stop({ blocking: true });
    } catch {
      // Best effort shutdown; we already dropped executor references.
    }
  };

  const upsertSkillsToSandbox = async (
    targetSandbox: Sandbox,
  ): Promise<void> => {
    await withSandboxSpan(
      "sandbox.sync_skills",
      "sandbox.sync",
      {
        "app.sandbox.skills_count": availableSkills.length,
      },
      async () => {
        const filesToWrite = await buildSkillSyncFiles(availableSkills);
        const bytesWritten = filesToWrite.reduce(
          (total, file) => total + file.content.length,
          0,
        );
        const directories = collectDirectories(filesToWrite);

        await withSandboxSpan(
          "sandbox.sync_writeFiles",
          "sandbox.sync.write",
          {
            "app.sandbox.sync.files_written": filesToWrite.length,
            "app.sandbox.sync.bytes_written": bytesWritten,
            "app.sandbox.sync.directories_ensured": directories.length,
          },
          async () => {
            try {
              for (const directory of directories) {
                try {
                  await targetSandbox.mkDir(directory);
                } catch (error) {
                  if (!isAlreadyExistsError(error)) {
                    throw error;
                  }
                }
              }

              await targetSandbox.writeFiles(filesToWrite);
              const executableFiles = filesToWrite
                .map((file) => file.path)
                .filter((filePath) =>
                  filePath.startsWith(`${SANDBOX_RUNTIME_BIN_DIR}/`),
                );
              for (const filePath of executableFiles) {
                const chmod = await runNonInteractiveCommand(targetSandbox, {
                  cmd: "chmod",
                  args: ["0755", filePath],
                  cwd: SANDBOX_WORKSPACE_ROOT,
                });
                if (chmod.exitCode !== 0) {
                  throw new Error(
                    `sandbox chmod failed for ${filePath}: ${(await chmod.stderr()) || (await chmod.stdout()) || `exit ${chmod.exitCode}`}`,
                  );
                }
              }
            } catch (error) {
              throwSandboxOperationError("sandbox writeFiles", error, true);
            }
          },
        );
      },
    );
  };

  const acquireSandbox = async (): Promise<Sandbox> => {
    return withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxIdHint),
        "app.sandbox.timeout_ms": timeoutMs,
        "app.sandbox.runtime": "node22",
        "app.sandbox.skills_count": availableSkills.length,
      },
      async () => {
        const sandboxCredentials = getVercelSandboxCredentials();
        const assignSandbox = (nextSandbox: Sandbox): Sandbox => {
          sandbox = nextSandbox;
          sandboxIdHint = nextSandbox.sandboxId;
          toolExecutors = undefined;
          return nextSandbox;
        };

        const handleSetupFailure = (error: unknown): never => {
          throw wrapSandboxSetupError(error);
        };

        const createFreshSandbox = async (): Promise<Sandbox> => {
          const runtime = SANDBOX_RUNTIME;
          let statusCount = 0;
          const sentStatuses = new Set<string>();
          const emitSandboxStatus = async (status: string): Promise<void> => {
            if (!emitStatus || statusCount >= 4 || sentStatuses.has(status)) {
              return;
            }
            sentStatuses.add(status);
            statusCount += 1;
            await emitStatus(status);
          };
          const reportSnapshotPhase = async (
            phase: RuntimeDependencySnapshotProgressPhase,
          ): Promise<void> => {
            if (phase === "resolve_start") {
              await emitSandboxStatus("Checking sandbox snapshot cache...");
              return;
            }
            if (phase === "waiting_for_lock") {
              await emitSandboxStatus("Waiting for sandbox snapshot build...");
              return;
            }
            if (phase === "building_snapshot") {
              await emitSandboxStatus("Building sandbox snapshot...");
              return;
            }
            if (phase === "cache_hit") {
              await emitSandboxStatus("Using cached sandbox snapshot...");
            }
          };

          let createdSandbox: Sandbox;
          try {
            createdSandbox = await withSandboxSpan(
              "sandbox.create",
              "sandbox.create",
              {
                "app.sandbox.reused": false,
                "app.sandbox.timeout_ms": timeoutMs,
                "app.sandbox.runtime": runtime,
              },
              async () => {
                await emitSandboxStatus("Preparing sandbox runtime...");
                const snapshot = await resolveRuntimeDependencySnapshot({
                  runtime,
                  timeoutMs,
                  onProgress: reportSnapshotPhase,
                });

                setSpanAttributes({
                  "app.sandbox.source": snapshot.snapshotId
                    ? "snapshot"
                    : "created",
                  "app.sandbox.snapshot.cache_hit": snapshot.cacheHit,
                  "app.sandbox.snapshot.resolve_outcome":
                    snapshot.resolveOutcome,
                  ...(snapshot.profileHash
                    ? {
                        "app.sandbox.snapshot.profile_hash":
                          snapshot.profileHash,
                      }
                    : {}),
                  "app.sandbox.snapshot.dependency_count":
                    snapshot.dependencyCount,
                  ...(snapshot.rebuildReason
                    ? {
                        "app.sandbox.snapshot.rebuild_reason":
                          snapshot.rebuildReason,
                      }
                    : {}),
                });

                if (!snapshot.snapshotId) {
                  await emitSandboxStatus("Booting up...");
                  return await Sandbox.create({
                    timeout: timeoutMs,
                    runtime,
                    ...(sandboxCredentials ?? {}),
                  });
                }

                try {
                  return await createSandboxFromSnapshot(
                    snapshot.snapshotId,
                    sandboxCredentials,
                    emitSandboxStatus,
                  );
                } catch (error) {
                  if (!isSnapshotMissingError(error)) {
                    throw error;
                  }

                  setSpanAttributes({
                    "app.sandbox.snapshot.rebuild_after_missing": true,
                  });
                  const rebuiltSnapshot =
                    await resolveRuntimeDependencySnapshot({
                      runtime,
                      timeoutMs,
                      forceRebuild: true,
                      staleSnapshotId: snapshot.snapshotId,
                      onProgress: reportSnapshotPhase,
                    });
                  if (!rebuiltSnapshot.snapshotId) {
                    throw error;
                  }

                  return await createSandboxFromSnapshot(
                    rebuiltSnapshot.snapshotId,
                    sandboxCredentials,
                    emitSandboxStatus,
                  );
                }
              },
            );
          } catch (error) {
            return handleSetupFailure(error);
          }

          try {
            await upsertSkillsToSandbox(createdSandbox);
          } catch (error) {
            return handleSetupFailure(error);
          }
          return assignSandbox(createdSandbox);
        };

        if (
          !sandbox &&
          sandboxIdHint &&
          dependencyProfileHash !== options?.sandboxDependencyProfileHash
        ) {
          setSpanAttributes({
            "app.sandbox.reused": false,
            "app.sandbox.recreate.reason": "dependency_profile_mismatch",
            ...(options?.sandboxDependencyProfileHash
              ? {
                  "app.sandbox.previous_profile_hash":
                    options.sandboxDependencyProfileHash,
                }
              : {}),
            ...(dependencyProfileHash
              ? { "app.sandbox.current_profile_hash": dependencyProfileHash }
              : {}),
          });
          sandboxIdHint = undefined;
        }

        const recoverUnavailableSandbox = async (
          source: "memory" | "id_hint",
        ): Promise<Sandbox> => {
          setSpanAttributes({
            "app.sandbox.recovery.attempted": true,
            "app.sandbox.recovery.source": source,
          });
          sandbox = null;
          sandboxIdHint = undefined;
          toolExecutors = undefined;
          const replacement = await createFreshSandbox();
          setSpanAttributes({
            "app.sandbox.recovery.succeeded": true,
          });
          return replacement;
        };

        if (sandbox) {
          const cachedSandbox = sandbox;
          try {
            await withSandboxSpan(
              "sandbox.reuse_cached",
              "sandbox.acquire.cached",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "memory",
              },
              async () => {
                await upsertSkillsToSandbox(cachedSandbox);
              },
            );
            return cachedSandbox;
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("memory");
            }
            return handleSetupFailure(error);
          }
        }

        let acquiredSandbox: Sandbox | null = null;
        if (sandboxIdHint) {
          try {
            acquiredSandbox = await withSandboxSpan(
              "sandbox.get",
              "sandbox.get",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "id_hint",
              },
              async () =>
                Sandbox.get({
                  sandboxId: sandboxIdHint as string,
                  ...(sandboxCredentials ?? {}),
                }),
            );
          } catch {
            acquiredSandbox = null;
          }
        }

        if (acquiredSandbox) {
          try {
            await upsertSkillsToSandbox(acquiredSandbox);
            return assignSandbox(acquiredSandbox);
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("id_hint");
            }
            return handleSetupFailure(error);
          }
        }

        return createFreshSandbox();
      },
    );
  };

  const getToolExecutors = async (): Promise<ToolExecutors> => {
    if (toolExecutors) {
      return toolExecutors;
    }

    const activeSandbox = await acquireSandbox();
    const toolkit = await withSandboxSpan(
      "sandbox.bash_tool.init",
      "sandbox.tool.init",
      {
        "app.sandbox.tool_name": "bash",
        "app.sandbox.destination": SANDBOX_WORKSPACE_ROOT,
      },
      async () =>
        createBashTool({
          sandbox: activeSandbox,
          destination: SANDBOX_WORKSPACE_ROOT,
        }),
    );

    const executeReadFile = toolkit.tools.readFile.execute;
    const executeWriteFile = toolkit.tools.writeFile.execute;
    if (!executeReadFile || !executeWriteFile) {
      throw new Error("bash-tool did not return executable tool handlers");
    }

    toolExecutors = {
      bash: async (input) => {
        const restoreNetworkPolicy = activeSandbox.networkPolicy ?? "allow-all";
        const headerTransforms = input.headerTransforms;
        if (headerTransforms && headerTransforms.length > 0) {
          const policy = mergeNetworkPolicyWithHeaderTransforms(
            restoreNetworkPolicy,
            headerTransforms,
          );
          await activeSandbox.updateNetworkPolicy(policy);
        }

        const script = buildNonInteractiveShellScript(input.command, {
          env: input.env,
          pathPrefix: `${SANDBOX_RUNTIME_BIN_DIR}:$PATH`,
        });
        let commandError: unknown;
        try {
          const commandResult = await activeSandbox.runCommand({
            cmd: "bash",
            args: ["-c", script],
            cwd: SANDBOX_WORKSPACE_ROOT,
          });
          const maxOutputLength = Number.parseInt(
            process.env.SANDBOX_BASH_MAX_OUTPUT_CHARS ?? "",
            10,
          );
          const boundedOutputLength =
            Number.isFinite(maxOutputLength) && maxOutputLength > 0
              ? maxOutputLength
              : DEFAULT_MAX_OUTPUT_LENGTH;
          const stdoutRaw = await commandResult.stdout();
          const stderrRaw = await commandResult.stderr();
          const stdout = truncateOutput(stdoutRaw, boundedOutputLength);
          const stderr = truncateOutput(stderrRaw, boundedOutputLength);
          return {
            stdout: stdout.value,
            stderr: stderr.value,
            exitCode: commandResult.exitCode,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          };
        } catch (error) {
          commandError = error;
          throw error;
        } finally {
          if (headerTransforms && headerTransforms.length > 0) {
            try {
              await activeSandbox.updateNetworkPolicy(restoreNetworkPolicy);
            } catch (restoreError) {
              await invalidateSandboxInstance(activeSandbox, restoreError);
              if (!commandError) {
                throw restoreError;
              }
            }
          }
        }
      },
      readFile: async (input) =>
        (await executeReadFile(input, {
          toolCallId: "sandbox-read-file",
          messages: [],
        })) as { content: string },
      writeFile: async (input) =>
        (await executeWriteFile(input, {
          toolCallId: "sandbox-write-file",
          messages: [],
        })) as { success: boolean },
    };

    return toolExecutors;
  };

  const execute = async <T>(
    params: SandboxExecutionInput,
  ): Promise<SandboxExecutionEnvelope<T>> => {
    const rawInput = (params.input ?? {}) as Record<string, unknown>;
    const bashCommand =
      params.toolName === "bash"
        ? String(rawInput.command ?? "").trim()
        : undefined;

    if (params.toolName === "bash") {
      if (!bashCommand) {
        throw new Error("command is required");
      }
      if (options?.runBashCustomCommand) {
        const custom = await options.runBashCustomCommand(bashCommand);
        if (custom.handled) {
          return { result: custom.result as T };
        }
      }
    }

    const activeSandbox = await acquireSandbox();
    const keepAliveMs = Number.parseInt(
      process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0",
      10,
    );
    if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
      try {
        await withSandboxSpan(
          "sandbox.keepalive.extend",
          "sandbox.keepalive",
          {
            "app.sandbox.keepalive_ms": keepAliveMs,
          },
          async () => {
            await activeSandbox.extendTimeout(keepAliveMs);
          },
        );
      } catch {
        // Best effort keepalive.
      }
    }

    if (params.toolName === "bash") {
      const command = bashCommand as string;
      const headerTransformsInput = rawInput.headerTransforms;
      const headerTransforms = Array.isArray(headerTransformsInput)
        ? headerTransformsInput
            .filter((value): value is Record<string, unknown> =>
              Boolean(value && typeof value === "object"),
            )
            .map((transform) => ({
              domain: String(transform.domain ?? "").trim(),
              headers:
                transform.headers &&
                typeof transform.headers === "object" &&
                !Array.isArray(transform.headers)
                  ? Object.fromEntries(
                      Object.entries(
                        transform.headers as Record<string, unknown>,
                      )
                        .filter(([, value]) => typeof value === "string")
                        .map(([key, value]) => [key, value as string]),
                    )
                  : {},
            }))
            .filter(
              (transform) =>
                transform.domain.length > 0 &&
                Object.keys(transform.headers).length > 0,
            )
        : undefined;
      const envInput = rawInput.env;
      const env =
        envInput && typeof envInput === "object" && !Array.isArray(envInput)
          ? Object.fromEntries(
              Object.entries(envInput as Record<string, unknown>)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
            )
          : undefined;

      const executeBash = (await getToolExecutors()).bash;
      const result = await withSandboxSpan(
        "bash",
        "process.exec",
        {
          "process.executable.name": "bash",
        },
        async () => {
          try {
            const response = await executeBash({
              command,
              ...(headerTransforms ? { headerTransforms } : {}),
              ...(env ? { env } : {}),
            });
            setSpanAttributes({
              "process.exit.code": response.exitCode,
              "app.sandbox.stdout_bytes": Buffer.byteLength(
                response.stdout ?? "",
                "utf8",
              ),
              "app.sandbox.stderr_bytes": Buffer.byteLength(
                response.stderr ?? "",
                "utf8",
              ),
              ...(response.exitCode !== 0
                ? { "error.type": "nonzero_exit" }
                : {}),
            });
            setSpanStatus(response.exitCode === 0 ? "ok" : "error");
            return response;
          } catch (error) {
            setSpanAttributes({
              "error.type":
                error instanceof Error ? error.name : "sandbox_execute_error",
            });
            setSpanStatus("error");
            throw error;
          }
        },
      );

      return {
        result: {
          ok: result.exitCode === 0,
          command,
          cwd: SANDBOX_WORKSPACE_ROOT,
          exit_code: result.exitCode,
          signal: null,
          timed_out: false,
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
        } as T,
      };
    }

    if (params.toolName === "readFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }

      const executeReadFile = (await getToolExecutors()).readFile;
      const result = await withSandboxSpan(
        "sandbox.readFile",
        "sandbox.fs.read",
        {
          "app.sandbox.path.length": filePath.length,
        },
        async () => {
          const response = await executeReadFile({ path: filePath });
          const content = String(response.content ?? "");
          setSpanAttributes({
            "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
            "app.sandbox.read.chars": content.length,
          });
          setSpanStatus("ok");
          return {
            content,
            path: filePath,
            success: true,
          };
        },
      );

      return { result: result as T };
    }

    if (params.toolName === "writeFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }

      const content = String(rawInput.content ?? "");
      const executeWriteFile = (await getToolExecutors()).writeFile;
      await withSandboxSpan(
        "sandbox.writeFile",
        "sandbox.fs.write",
        {
          "app.sandbox.path.length": filePath.length,
          "app.sandbox.write.bytes": Buffer.byteLength(content, "utf8"),
        },
        async () => {
          try {
            await executeWriteFile({ path: filePath, content });
            setSpanStatus("ok");
          } catch (error) {
            throwSandboxOperationError("sandbox writeFile", error);
          }
        },
      );

      return {
        result: {
          ok: true,
          path: filePath,
          bytes_written: Buffer.byteLength(content, "utf8"),
        } as T,
      };
    }

    throw new Error(`unsupported sandbox tool: ${params.toolName}`);
  };

  const dispose = async (): Promise<void> => {
    if (!sandbox) {
      return;
    }

    await withSandboxSpan(
      "sandbox.stop",
      "sandbox.stop",
      {
        "app.sandbox.stop.blocking": true,
      },
      async () => {
        await (sandbox as Sandbox).stop({ blocking: true });
      },
    );

    sandbox = null;
    toolExecutors = undefined;
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
    },
    getSandboxId() {
      return sandbox?.sandboxId ?? sandboxIdHint;
    },
    getDependencyProfileHash() {
      return dependencyProfileHash;
    },
    canExecute(toolName: string) {
      return SANDBOX_TOOL_NAMES.has(toolName);
    },
    async createSandbox() {
      return await acquireSandbox();
    },
    execute,
    dispose,
  };
}
