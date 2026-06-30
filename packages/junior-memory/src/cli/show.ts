import type { Command } from "commander";
import type {
  PluginCliActionContext,
  PluginCliHost,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { juniorMemoryMemories } from "../db/schema";
import type { MemoryDb } from "../store";
import { formatMemory } from "./format";

async function runShow(
  ctx: PluginCliActionContext,
  id: string,
): Promise<number> {
  const db = ctx.db as MemoryDb;
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(eq(juniorMemoryMemories.id, id))
    .limit(1);
  if (!rows[0]) {
    await ctx.io.writeError(`Memory not found: ${id}\n`);
    return 1;
  }

  await ctx.io.writeOutput(`${formatMemory(rows[0], { showContent: true })}\n`);
  return 0;
}

/** Wire the explicit raw-content memory inspection subcommand. */
export function configureMemoryShowCommand(
  parent: Command,
  junior: PluginCliHost,
): void {
  parent
    .command("show")
    .description("Show one memory")
    .argument("<id>", "Memory id")
    .action(
      junior.action(async (ctx, id) => {
        return await runShow(ctx, id as string);
      }),
    );
}
