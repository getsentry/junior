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
  const result = await reembedMemories({
    batchSize: options.batchSize,
    db: ctx.db as MemoryDb,
    embedder: ctx.embedder,
    onBatch: async (progress) => {
      await ctx.io.writeOutput(
        `embedded ${progress.embedded} (checked ${progress.scanned})\n`,
      );
    },
  });
  const model = result.model ? ` with ${result.provider} ${result.model}` : "";
  await ctx.io.writeOutput(
    `Done: embedded ${result.embedded} of ${result.scanned} memories${model}.\n`,
  );
  return 0;
}

/** Wire the one-off backfill for the configured embedding model. */
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
