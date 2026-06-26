import { flush } from "@/chat/sentry";
import { initSentry } from "@/instrumentation";
import { loadCliEnvFiles } from "./env";
import { runCli } from "./run";

const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

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

async function runUpgrade(): Promise<void> {
  const mod = await import("./upgrade");
  await mod.runUpgrade();
}

async function runChat(argv: string[]): Promise<number> {
  const mod = await import("./chat");
  return await mod.runChat(argv);
}

function topLevelCommand(argv: string[]): string | undefined {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  return normalized[0];
}

async function main(argv: string[]): Promise<void> {
  loadCliEnvFiles();
  initSentry();
  const command = topLevelCommand(argv);
  const pluginCommands =
    command && command !== "init"
      ? await import("./plugins").then((mod) => mod.loadCliPluginCommands())
      : undefined;
  const exitCode = await runCli(argv, {
    runChat,
    runInit,
    runSnapshotCreate,
    runCheck,
    runUpgrade,
    ...(pluginCommands ? { runPluginCommand: pluginCommands.run } : {}),
  });
  await flush(SENTRY_FLUSH_TIMEOUT_MS);
  process.exit(exitCode);
}

main(process.argv.slice(2)).catch((error) => {
  void (async () => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`junior command failed: ${message}`);
    await flush(SENTRY_FLUSH_TIMEOUT_MS);
    process.exit(1);
  })();
});
