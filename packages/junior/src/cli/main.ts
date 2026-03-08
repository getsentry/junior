import { runInit } from "./init";
import { runSnapshotCreate } from "./snapshot-warmup";

async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;

  if (command === "init") {
    if (!subcommand) {
      throw new Error("usage: junior init <dir>");
    }
    await runInit(subcommand);
    return;
  }

  if (command === "snapshot" && subcommand === "create") {
    await runSnapshotCreate();
    return;
  }

  console.error("usage: junior init <dir>\n       junior snapshot create");
  process.exit(1);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
