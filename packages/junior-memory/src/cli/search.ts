import { InvalidArgumentError, Option, type Command } from "commander";
import { and, desc, eq, gt, ilike, isNull, or, type SQL } from "drizzle-orm";
import type {
  PluginCliActionContext,
  PluginCliHost,
} from "@sentry/junior-plugin-api";
import { juniorMemoryMemories } from "../db/schema";
import type { MemoryDb } from "../store";
import { MEMORY_SCOPES, type MemoryScope } from "../types";
import { formatMemory } from "./format";

interface SearchOptions {
  limit: number;
  scope: MemoryScope;
  scopeKey: string;
  showContent?: boolean;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("--limit must be a number");
  }
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

async function runSearch(
  ctx: PluginCliActionContext,
  queryParts: string[] | undefined,
  options: SearchOptions,
): Promise<number> {
  const query = (queryParts ?? []).join(" ").trim();
  const nowMs = Date.now();
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_'-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ];

  const db = ctx.db as MemoryDb;
  const activeExpirationPredicate = or(
    isNull(juniorMemoryMemories.expiresAtMs),
    gt(juniorMemoryMemories.expiresAtMs, nowMs),
  );
  const predicates: SQL[] = [
    eq(juniorMemoryMemories.scope, options.scope),
    eq(juniorMemoryMemories.scopeKey, options.scopeKey),
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
  ];
  if (activeExpirationPredicate) {
    predicates.push(activeExpirationPredicate);
  }
  if (terms.length > 0) {
    const termPredicate = or(
      ...terms.map((term) => ilike(juniorMemoryMemories.content, `%${term}%`)),
    );
    if (termPredicate) {
      predicates.push(termPredicate);
    }
  }
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(and(...predicates))
    .orderBy(desc(juniorMemoryMemories.createdAtMs))
    .limit(options.limit);

  if (rows.length === 0) {
    await ctx.io.writeOutput("No memories matched.\n");
    return 0;
  }

  await ctx.io.writeOutput(
    `${rows
      .map((row) =>
        formatMemory(row, { showContent: Boolean(options.showContent) }),
      )
      .join("\n\n")}\n`,
  );
  return 0;
}

/** Wire the memory search admin subcommand under the plugin namespace. */
export function configureMemorySearchCommand(
  parent: Command,
  junior: PluginCliHost,
): void {
  parent
    .command("search")
    .description("Search visible memories")
    .argument("[query...]", "Search query")
    .addOption(
      new Option("--scope <scope>", "Memory scope")
        .choices([...MEMORY_SCOPES])
        .makeOptionMandatory(),
    )
    .requiredOption("--scope-key <key>", "Scope key")
    .addOption(
      new Option("--limit <n>", "Maximum rows")
        .argParser(parseLimit)
        .default(20),
    )
    .option("--show-content", "Print raw memory content")
    .action(
      junior.action(async (ctx, queryParts, options) => {
        return await runSearch(
          ctx,
          queryParts as string[] | undefined,
          options as SearchOptions,
        );
      }),
    );
}
