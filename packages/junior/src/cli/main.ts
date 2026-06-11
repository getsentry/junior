import { loadCliEnvFiles } from "./env";
import { runCli } from "./run";

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

async function main(argv: string[]): Promise<void> {
  loadCliEnvFiles();
  const exitCode = await runCli(argv, {
    runChat,
    runInit,
    runSnapshotCreate,
    runCheck,
    runUpgrade,
  });
  process.exit(exitCode);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
