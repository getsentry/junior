import { InvalidArgumentError, type Command } from "commander";
import type {
  PluginCliActionContext,
  PluginCliHost,
} from "@sentry/junior-plugin-api";
import { reembedMemories } from "../reembed";
import type { MemoryDb } from "../store";

const DEFAULT_BATCH_SIZE = 100;

function parseBatchSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new InvalidArgumentError(
      "--batch-size must be an integer from 1 to 1000",
    );
  }
  return parsed;
}

async function runReembed(
  ctx: PluginCliActionContext,
  options: { batchSize: number },
): Promise<number> {
  const embedded = await reembedMemories({
    batchSize: options.batchSize,
    db: ctx.db as MemoryDb,
    embedder: ctx.embedder,
    onBatch: async (count) => {
      await ctx.io.writeOutput(`embedded ${count}\n`);
    },
  });
  const noun = embedded === 1 ? "memory" : "memories";
  await ctx.io.writeOutput(
    `Done: embedded ${embedded} ${noun} with ${ctx.embedder.provider} ${ctx.embedder.model}.\n`,
  );
  return 0;
}

/** Wire a manual run of the memory vector backfill for the configured model. */
export function configureMemoryReembedCommand(
  parent: Command,
  junior: PluginCliHost,
): void {
  parent
    .command("reembed")
    .description(
      "Embed memories that have no current vector for the configured embedding model",
    )
    .option(
      "--batch-size <count>",
      "Memories per embedding call",
      parseBatchSize,
      DEFAULT_BATCH_SIZE,
    )
    .action(
      junior.action(async (ctx, options) => {
        return await runReembed(ctx, options as { batchSize: number });
      }),
    );
}
