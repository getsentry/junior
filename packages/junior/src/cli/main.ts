import { pathToFileURL } from "node:url";
import { loadCliEnvFiles } from "./env";
import { runCli } from "./run";
import type { JuniorPluginSet } from "../plugins";

const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

async function flushSentry(): Promise<void> {
  const mod = await import("../chat/sentry");
  await mod.flush(SENTRY_FLUSH_TIMEOUT_MS);
}

async function initSentry(): Promise<void> {
  const mod = await import("../instrumentation");
  mod.initSentry();
}

async function runInit(dir: string): Promise<void> {
  const mod = await import("./init");
  await mod.runInit(dir);
}

async function runSnapshotCreate(): Promise<void> {
  const mod = await import("./snapshot-warmup");
  await mod.runSnapshotCreate();
}

async function runCheck(dir?: string): Promise<void> {
  const mod = await import("./check");
  await mod.runCheck(dir);
}

async function runUpgrade(pluginSet?: JuniorPluginSet | null): Promise<void> {
  const mod = await import("./upgrade");
  await mod.runUpgrade(undefined, { pluginSet });
}

async function runChat(
  argv: string[],
  pluginSet?: JuniorPluginSet | null,
): Promise<number> {
  const mod = await import("./chat");
  return await mod.runChat(argv, undefined, { pluginSet });
}

function topLevelCommand(argv: string[]): string | undefined {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  return normalized[0];
}

/** Run the packaged CLI entrypoint with plugin command bootstrap enabled. */
export async function runMain(
  argv: string[],
  options: { instrument?: boolean } = {},
): Promise<void> {
  loadCliEnvFiles();
  const instrument = options.instrument ?? true;
  if (instrument) {
    await initSentry();
  }
  const command = topLevelCommand(argv);
  const cliPluginsModule =
    command && command !== "init" ? await import("./plugins") : undefined;
  const pluginSet = cliPluginsModule
    ? ((await cliPluginsModule.loadCliPluginSet()) ?? null)
    : undefined;
  const pluginCommands = cliPluginsModule
    ? await cliPluginsModule.loadCliPluginCommands(pluginSet)
    : undefined;
  const exitCode = await runCli(argv, {
    runChat: async (chatArgv) => await runChat(chatArgv, pluginSet),
    runInit,
    runSnapshotCreate,
    runCheck,
    runUpgrade: async () => await runUpgrade(pluginSet),
    ...(pluginCommands ? { runPluginCommand: pluginCommands.run } : {}),
  });
  if (instrument) {
    await flushSentry();
  }
  process.exit(exitCode);
}

function isDirectCliEntry(): boolean {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
  );
}

if (isDirectCliEntry()) {
  runMain(process.argv.slice(2)).catch((error) => {
    void (async () => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`junior command failed: ${message}`);
      await flushSentry();
      process.exit(1);
    })();
  });
}
