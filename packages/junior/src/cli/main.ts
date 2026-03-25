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

async function main(argv: string[]): Promise<void> {
  loadCliEnvFiles();
  const exitCode = await runCli(argv, {
    runInit,
    runSnapshotCreate,
    runCheck,
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
