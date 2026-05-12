import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import {
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isAlreadyExistsError,
  isSandboxUnavailableError,
  isSnapshottingError,
  wrapSandboxSetupError,
} from "@/chat/sandbox/errors";
import { buildNonInteractiveShellScript } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import {
  getRuntimeDependencyProfileHash,
  isSnapshotMissingError,
  resolveRuntimeDependencySnapshot,
  type RuntimeDependencySnapshot,
} from "@/chat/sandbox/runtime-dependency-snapshots";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import type { SkillMetadata } from "@/chat/skills";
import type { SandboxFileSystem } from "@/chat/tools/sandbox/file-utils";
import type { PluginCommandProxy } from "@/chat/plugins/types";
import {
  COMMAND_PROXY_ACTIVATE_PREFIX,
  COMMAND_PROXY_ACK_DIR,
  commandProxyAckPath,
  type CommandProxyActivationInput,
  type CommandProxyActivationResult,
} from "@/chat/sandbox/command-proxy-protocol";

const DEFAULT_MAX_OUTPUT_LENGTH = 30_000;
const SANDBOX_RUNTIME = "node22";
const SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
const SNAPSHOT_BOOT_RETRY_COUNT = 3;
const SNAPSHOT_BOOT_RETRY_DELAY_MS = 1000;

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface NetworkPolicyAllowEntry {
  transform?: Array<{ headers: Record<string, string> }>;
}

interface SandboxToolExecutors {
  bash: (input: {
    command: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut?: boolean;
    commandProxyProviders?: string[];
    commandProxyAuthRequiredProviders?: string[];
  }>;
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: {
    path: string;
    content: string;
  }) => Promise<{ success: boolean }>;
  fs: SandboxFileSystem;
}

interface SandboxSessionManager {
  configureSkills(skills: SkillMetadata[]): void;
  configureReferenceFiles(files: string[]): void;
  getSandboxId(): string | undefined;
  getDependencyProfileHash(): string | undefined;
  createSandbox(): Promise<Sandbox>;
  ensureToolExecutors(): Promise<SandboxToolExecutors>;
  dispose(): Promise<void>;
}

function mergeNetworkPolicyWithHeaderTransforms(
  networkPolicy: unknown,
  headerTransforms: Array<{ domain: string; headers: Record<string, string> }>,
): { allow: Record<string, NetworkPolicyAllowEntry[]> } & Record<
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
  let existingAllow: Record<string, NetworkPolicyAllowEntry[]>;
  if (networkPolicy === "allow-all") {
    existingAllow = { "*": [] };
  } else if (Array.isArray(existingAllowRaw)) {
    existingAllow = Object.fromEntries(
      existingAllowRaw
        .filter((domain): domain is string => typeof domain === "string")
        .map((domain) => [domain, []]),
    );
  } else if (
    existingAllowRaw &&
    typeof existingAllowRaw === "object" &&
    !Array.isArray(existingAllowRaw)
  ) {
    existingAllow = Object.fromEntries(
      Object.entries(existingAllowRaw as Record<string, unknown>).map(
        ([domain, rules]) => [
          domain,
          Array.isArray(rules) ? ([...rules] as NetworkPolicyAllowEntry[]) : [],
        ],
      ),
    );
  } else {
    existingAllow = {};
  }

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

interface CommandProxyActivationRequest {
  id: string;
  provider: string;
  command: string;
}

interface CommandProxyRunState {
  providers: Set<string>;
  authRequiredProviders: Set<string>;
}

class CommandOutputCapture extends Writable {
  private buffered = "";
  private readonly chunks: string[] = [];

  constructor(private readonly onLine: (line: string) => Promise<boolean>) {
    super();
  }

  get output(): string {
    return this.chunks.join("");
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    void this.writeText(text).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.flushBuffered().then(() => callback(), callback);
  }

  private async writeText(text: string): Promise<void> {
    this.buffered += text;
    while (true) {
      const newlineIndex = this.buffered.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffered.slice(0, newlineIndex + 1);
      this.buffered = this.buffered.slice(newlineIndex + 1);
      await this.handleLine(line);
    }
  }

  private async flushBuffered(): Promise<void> {
    if (!this.buffered) {
      return;
    }
    const line = this.buffered;
    this.buffered = "";
    await this.handleLine(line);
  }

  private async handleLine(lineWithEnding: string): Promise<void> {
    const line = lineWithEnding.replace(/\r?\n$/, "");
    if (await this.onLine(line)) {
      return;
    }
    this.chunks.push(lineWithEnding);
  }
}

function parseCommandProxyActivationLine(
  line: string,
): CommandProxyActivationRequest | undefined {
  if (!line.startsWith(COMMAND_PROXY_ACTIVATE_PREFIX)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(COMMAND_PROXY_ACTIVATE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const request = parsed as {
    id?: unknown;
    provider?: unknown;
    command?: unknown;
  };
  if (
    typeof request.id !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(request.id) ||
    typeof request.provider !== "string" ||
    typeof request.command !== "string"
  ) {
    return undefined;
  }

  return {
    id: request.id,
    provider: request.provider,
    command: request.command,
  };
}

function isDeclaredCommandProxy(
  request: CommandProxyActivationRequest,
  commandProxies: PluginCommandProxy[],
): boolean {
  return commandProxies.some(
    (proxy) =>
      proxy.provider === request.provider && proxy.command === request.command,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseKeepAliveMs(): number {
  const parsed = Number.parseInt(
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Manage sandbox lifecycle, sync, keepalive, and tool executor caching for one executor instance. */
export function createSandboxSessionManager(options?: {
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  timeoutMs?: number;
  traceContext?: LogContext;
  commandProxies?: PluginCommandProxy[];
  activateCommandProxy?: (
    input: CommandProxyActivationInput,
  ) => Promise<CommandProxyActivationResult>;
  onSandboxAcquired?: (sandbox: {
    sandboxId: string;
    sandboxDependencyProfileHash?: string;
  }) => void | Promise<void>;
}): SandboxSessionManager {
  let sandbox: Sandbox | null = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills: SkillMetadata[] = [];
  let availableReferenceFiles: string[] = [];
  let toolExecutors: SandboxToolExecutors | undefined;

  const timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  const traceContext = options?.traceContext ?? {};
  const dependencyProfileHash =
    getRuntimeDependencyProfileHash(SANDBOX_RUNTIME);
  const commandProxies = options?.commandProxies ?? [];

  const withSandboxSpan = <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ): Promise<T> => withSpan(name, op, traceContext, callback, attributes);

  const clearSession = (): void => {
    sandbox = null;
    sandboxIdHint = undefined;
    toolExecutors = undefined;
  };

  const rememberSandbox = async (nextSandbox: Sandbox): Promise<Sandbox> => {
    sandbox = nextSandbox;
    sandboxIdHint = nextSandbox.sandboxId;
    toolExecutors = undefined;
    await options?.onSandboxAcquired?.({
      sandboxId: nextSandbox.sandboxId,
      ...(dependencyProfileHash
        ? { sandboxDependencyProfileHash: dependencyProfileHash }
        : {}),
    });
    return nextSandbox;
  };

  const failSetup = (error: unknown): never => {
    throw wrapSandboxSetupError(error);
  };

  const syncSkills = async (targetSandbox: Sandbox): Promise<void> => {
    await syncSkillsToSandbox({
      sandbox: targetSandbox,
      skills: availableSkills,
      referenceFiles: availableReferenceFiles,
      withSpan: withSandboxSpan,
      runtimeBinDir: SANDBOX_RUNTIME_BIN_DIR,
      commandProxies,
    });
  };

  const ensureSandboxReachable = async (
    targetSandbox: Sandbox,
    source: "memory" | "id_hint",
  ): Promise<void> => {
    await withSandboxSpan(
      "sandbox.reuse_probe",
      "sandbox.acquire.probe",
      {
        "app.sandbox.reused": true,
        "app.sandbox.source": source,
      },
      async () => {
        try {
          await targetSandbox.mkDir(SANDBOX_WORKSPACE_ROOT);
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
        }
      },
    );
  };

  const invalidateSandboxInstance = async (
    targetSandbox: Sandbox,
    reason: unknown,
  ): Promise<void> => {
    if (sandbox === targetSandbox) {
      clearSession();
    }
    logWarn(
      "sandbox_network_policy_restore_failed",
      traceContext,
      {
        "exception.message":
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

  const recreateUnavailableSandbox = async (
    source: "memory" | "id_hint",
  ): Promise<Sandbox> => {
    setSpanAttributes({
      "app.sandbox.recovery.attempted": true,
      "app.sandbox.recovery.source": source,
    });
    clearSession();
    const replacement = await createFreshSandbox();
    setSpanAttributes({
      "app.sandbox.recovery.succeeded": true,
    });
    return replacement;
  };

  const createSandboxFromSnapshot = async (
    snapshotId: string,
    sandboxCredentials: SandboxCredentials | undefined,
  ): Promise<Sandbox> => {
    for (let attempt = 0; attempt < SNAPSHOT_BOOT_RETRY_COUNT; attempt += 1) {
      try {
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

  const setSnapshotAttributes = (snapshot: RuntimeDependencySnapshot): void => {
    setSpanAttributes({
      "app.sandbox.source": snapshot.snapshotId ? "snapshot" : "created",
      "app.sandbox.snapshot.cache_hit": snapshot.cacheHit,
      "app.sandbox.snapshot.resolve_outcome": snapshot.resolveOutcome,
      ...(snapshot.profileHash
        ? {
            "app.sandbox.snapshot.profile_hash": snapshot.profileHash,
          }
        : {}),
      "app.sandbox.snapshot.dependency_count": snapshot.dependencyCount,
      ...(snapshot.rebuildReason
        ? {
            "app.sandbox.snapshot.rebuild_reason": snapshot.rebuildReason,
          }
        : {}),
    });
  };

  const createSandboxFromResolvedSnapshot = async (params: {
    runtime: string;
    snapshot: RuntimeDependencySnapshot;
    sandboxCredentials: SandboxCredentials | undefined;
  }): Promise<Sandbox> => {
    const { runtime, snapshot, sandboxCredentials } = params;

    if (!snapshot.snapshotId) {
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
      );
    } catch (error) {
      if (!isSnapshotMissingError(error)) {
        throw error;
      }

      setSpanAttributes({
        "app.sandbox.snapshot.rebuild_after_missing": true,
      });
      const rebuiltSnapshot = await resolveRuntimeDependencySnapshot({
        runtime,
        timeoutMs,
        forceRebuild: true,
        staleSnapshotId: snapshot.snapshotId,
      });
      if (!rebuiltSnapshot.snapshotId) {
        throw error;
      }

      return await createSandboxFromSnapshot(
        rebuiltSnapshot.snapshotId,
        sandboxCredentials,
      );
    }
  };

  const createFreshSandbox = async (): Promise<Sandbox> => {
    const runtime = SANDBOX_RUNTIME;
    const sandboxCredentials = getVercelSandboxCredentials();

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
          const snapshot = await resolveRuntimeDependencySnapshot({
            runtime,
            timeoutMs,
          });
          setSnapshotAttributes(snapshot);
          return await createSandboxFromResolvedSnapshot({
            runtime,
            snapshot,
            sandboxCredentials,
          });
        },
      );
    } catch (error) {
      return failSetup(error);
    }

    try {
      await syncSkills(createdSandbox);
    } catch (error) {
      return failSetup(error);
    }

    return await rememberSandbox(createdSandbox);
  };

  const discardHintIfProfileChanged = (): void => {
    if (
      sandbox ||
      !sandboxIdHint ||
      dependencyProfileHash === options?.sandboxDependencyProfileHash
    ) {
      return;
    }

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
  };

  const tryReuseCachedSandbox = async (): Promise<Sandbox | null> => {
    const cachedSandbox = sandbox;
    if (!cachedSandbox) {
      return null;
    }

    try {
      await ensureSandboxReachable(cachedSandbox, "memory");
      return cachedSandbox;
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("memory");
      }
      return failSetup(error);
    }
  };

  const tryRestoreHintedSandbox = async (): Promise<Sandbox | null> => {
    if (!sandboxIdHint) {
      return null;
    }

    let hintedSandbox: Sandbox | null = null;
    try {
      const sandboxCredentials = getVercelSandboxCredentials();
      hintedSandbox = await withSandboxSpan(
        "sandbox.get",
        "sandbox.get",
        {
          "app.sandbox.reused": true,
          "app.sandbox.source": "id_hint",
        },
        async () =>
          await Sandbox.get({
            sandboxId: sandboxIdHint as string,
            ...(sandboxCredentials ?? {}),
          }),
      );
    } catch {
      return null;
    }

    try {
      await syncSkills(hintedSandbox);
      return await rememberSandbox(hintedSandbox);
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        return await recreateUnavailableSandbox("id_hint");
      }
      return failSetup(error);
    }
  };

  const acquireSandbox = async (): Promise<Sandbox> => {
    return await withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxIdHint),
        "app.sandbox.timeout_ms": timeoutMs,
        "app.sandbox.runtime": SANDBOX_RUNTIME,
        "app.sandbox.skills_count": availableSkills.length,
      },
      async () => {
        discardHintIfProfileChanged();

        const cachedSandbox = await tryReuseCachedSandbox();
        if (cachedSandbox) {
          return cachedSandbox;
        }

        const hintedSandbox = await tryRestoreHintedSandbox();
        if (hintedSandbox) {
          return hintedSandbox;
        }

        return await createFreshSandbox();
      },
    );
  };

  const getMaxOutputLength = (): number => {
    const maxOutputLength = Number.parseInt(
      process.env.SANDBOX_BASH_MAX_OUTPUT_CHARS ?? "",
      10,
    );
    return Number.isFinite(maxOutputLength) && maxOutputLength > 0
      ? maxOutputLength
      : DEFAULT_MAX_OUTPUT_LENGTH;
  };

  const formatCommandOutput = (input: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }): {
    stdout: string;
    stderr: string;
    exitCode: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  } => {
    const boundedOutputLength = getMaxOutputLength();
    const stdout = truncateOutput(input.stdout, boundedOutputLength);
    const stderr = truncateOutput(input.stderr, boundedOutputLength);
    return {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: input.exitCode,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  };

  const withCommandProxyActivation = async <T extends { exitCode: number }>(
    sandboxInstance: Sandbox,
    callback: (streams: { stdout: Writable; stderr: Writable }) => Promise<T>,
  ): Promise<
    T & {
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      commandProxyProviders?: string[];
      commandProxyAuthRequiredProviders?: string[];
    }
  > => {
    const restoreNetworkPolicy = sandboxInstance.networkPolicy ?? "allow-all";
    const state: CommandProxyRunState = {
      providers: new Set<string>(),
      authRequiredProviders: new Set<string>(),
    };
    let policyChanged = false;

    const writeAck = async (
      request: CommandProxyActivationRequest,
      ack: unknown,
    ): Promise<void> => {
      await sandboxInstance.fs.mkdir(COMMAND_PROXY_ACK_DIR, {
        recursive: true,
      });
      await sandboxInstance.fs.writeFile(
        commandProxyAckPath(request.id),
        JSON.stringify(ack),
        "utf8",
      );
    };

    const handleActivation = async (
      request: CommandProxyActivationRequest,
    ): Promise<void> => {
      if (!isDeclaredCommandProxy(request, commandProxies)) {
        await writeAck(request, {
          status: "error",
          provider: request.provider,
          message: `Unknown Junior command proxy: ${request.command}`,
        });
        return;
      }

      if (!options?.activateCommandProxy) {
        await writeAck(request, {
          status: "error",
          provider: request.provider,
          message: `No Junior command proxy activator registered for provider ${request.provider}`,
        });
        return;
      }

      try {
        const activation = await options.activateCommandProxy({
          provider: request.provider,
          command: request.command,
        });

        if (activation.status === "ok") {
          state.providers.add(request.provider);
          if (
            activation.headerTransforms &&
            activation.headerTransforms.length > 0
          ) {
            const policy = mergeNetworkPolicyWithHeaderTransforms(
              restoreNetworkPolicy,
              activation.headerTransforms,
            );
            await sandboxInstance.updateNetworkPolicy(policy);
            policyChanged = true;
          }
          await writeAck(request, {
            status: "ok",
            provider: request.provider,
            ...(activation.env ? { env: activation.env } : {}),
          });
          return;
        }

        if (activation.status === "auth_required") {
          state.authRequiredProviders.add(request.provider);
        }
        await writeAck(request, {
          status: activation.status,
          provider: request.provider,
          message: activation.message,
        });
      } catch (error) {
        await writeAck(request, {
          status: "error",
          provider: request.provider,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const onLine = async (line: string): Promise<boolean> => {
      if (!line.startsWith(COMMAND_PROXY_ACTIVATE_PREFIX)) {
        return false;
      }
      const request = parseCommandProxyActivationLine(line);
      if (request) {
        await handleActivation(request);
      }
      return true;
    };

    const stdout = new CommandOutputCapture(onLine);
    const stderr = new CommandOutputCapture(onLine);
    const endStream = (stream: Writable): Promise<void> =>
      new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => {
          stream.off("error", reject);
          resolve();
        });
      });

    let streamError: unknown;
    let restoreError: unknown;
    let result: T | undefined;

    try {
      result = await callback({ stdout, stderr });
    } finally {
      try {
        await Promise.all([endStream(stdout), endStream(stderr)]);
      } catch (error) {
        streamError = error;
      }
      if (policyChanged) {
        try {
          await sandboxInstance.updateNetworkPolicy(restoreNetworkPolicy);
        } catch (error) {
          restoreError = error;
          await invalidateSandboxInstance(sandboxInstance, error);
        }
      }
    }

    if (streamError) {
      throw streamError;
    }
    if (restoreError) {
      throw restoreError;
    }

    const output = formatCommandOutput({
      stdout: stdout.output,
      stderr: stderr.output,
      exitCode: result!.exitCode,
    });
    const providers = [...state.providers].sort((left, right) =>
      left.localeCompare(right),
    );
    const authRequiredProviders = [...state.authRequiredProviders].sort(
      (left, right) => left.localeCompare(right),
    );

    return {
      ...result!,
      ...output,
      ...(providers.length > 0 ? { commandProxyProviders: providers } : {}),
      ...(authRequiredProviders.length > 0
        ? { commandProxyAuthRequiredProviders: authRequiredProviders }
        : {}),
    };
  };

  const extendKeepAlive = async (activeSandbox: Sandbox): Promise<void> => {
    const keepAliveMs = parseKeepAliveMs();
    if (keepAliveMs === 0) {
      return;
    }

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
  };

  const buildToolExecutors = async (
    sandboxInstance: Sandbox,
  ): Promise<SandboxToolExecutors> => {
    return {
      bash: async (input) => {
        // Production bash runs inside Vercel Sandbox; host hooks are handled before this executor.
        const script = buildNonInteractiveShellScript(input.command, {
          env: input.env,
          pathPrefix: `${SANDBOX_RUNTIME_BIN_DIR}:$PATH`,
        });
        const controller =
          input.timeoutMs && input.timeoutMs > 0
            ? new AbortController()
            : undefined;
        let timedOut = false;
        const timeoutId = controller
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, input.timeoutMs)
          : undefined;
        return await withCommandProxyActivation(
          sandboxInstance,
          async (streams) => {
            try {
              const commandResult = await sandboxInstance.runCommand({
                cmd: "bash",
                args: ["-c", script],
                cwd: SANDBOX_WORKSPACE_ROOT,
                stdout: streams.stdout,
                stderr: streams.stderr,
                ...(controller ? { signal: controller.signal } : {}),
              });
              return { exitCode: commandResult.exitCode };
            } catch (error) {
              if (timedOut) {
                streams.stderr.write(
                  `Command timed out after ${input.timeoutMs}ms`,
                );
                return {
                  exitCode: 124,
                  timedOut: true,
                };
              }
              throw error;
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            }
          },
        );
      },
      readFile: async (input) => ({
        content: await sandboxInstance.fs.readFile(input.path, {
          encoding: "utf8",
        }),
      }),
      writeFile: async (input) => {
        await sandboxInstance.fs.writeFile(input.path, input.content, {
          encoding: "utf8",
        });
        return { success: true };
      },
      fs: sandboxInstance.fs as SandboxFileSystem,
    };
  };

  const ensureReadySandbox = async (): Promise<Sandbox> => {
    const activeSandbox = await acquireSandbox();
    await extendKeepAlive(activeSandbox);
    return activeSandbox;
  };

  const loadToolExecutors = async (
    activeSandbox: Sandbox,
  ): Promise<SandboxToolExecutors> => {
    if (toolExecutors) {
      return toolExecutors;
    }

    toolExecutors = await buildToolExecutors(activeSandbox);
    return toolExecutors;
  };

  return {
    configureSkills(skills: SkillMetadata[]) {
      availableSkills = [...skills];
    },
    configureReferenceFiles(files: string[]) {
      availableReferenceFiles = [...files];
    },
    getSandboxId() {
      return sandbox?.sandboxId ?? sandboxIdHint;
    },
    getDependencyProfileHash() {
      return dependencyProfileHash;
    },
    async createSandbox() {
      return await acquireSandbox();
    },
    async ensureToolExecutors() {
      return await loadToolExecutors(await ensureReadySandbox());
    },
    async dispose() {
      const activeSandbox = sandbox;
      if (!activeSandbox) {
        return;
      }

      await withSandboxSpan(
        "sandbox.stop",
        "sandbox.stop",
        {
          "app.sandbox.stop.blocking": true,
        },
        async () => {
          await activeSandbox.stop({ blocking: true });
        },
      );

      sandbox = null;
      toolExecutors = undefined;
    },
  };
}
