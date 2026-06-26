import { and, desc, eq, gt, ilike, isNull, or, type SQL } from "drizzle-orm";
import type {
  PluginCliCommandContext,
  PluginCliCommandDefinition,
} from "@sentry/junior-plugin-api";
import { juniorMemoryMemories } from "./db/schema";
import type { MemoryDb } from "./store";
import { MEMORY_SCOPES, type MemoryScope } from "./types";

const USAGE = `usage: junior memory search [query] --scope <personal|conversation> --scope-key <key> [--limit <n>] [--show-content]
       junior memory show <id>`;

interface SearchOptions {
  limit: number;
  query?: string;
  scope: MemoryScope;
  scopeKey: string;
  showContent: boolean;
}

function isMemoryScope(value: string): value is MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope);
}

function parseLimit(value: string | undefined): number {
  if (!value) {
    return 20;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("--limit must be a number");
  }
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

function parseSearchArgs(argv: string[]): SearchOptions {
  const args = [...argv];
  const queryParts: string[] = [];
  let limit = 20;
  let scope: MemoryScope | undefined;
  let scopeKey: string | undefined;
  let showContent = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) {
      continue;
    }
    if (arg === "--show-content") {
      showContent = true;
      continue;
    }
    if (arg === "--limit") {
      limit = parseLimit(args.shift());
      continue;
    }
    if (arg === "--scope") {
      const value = args.shift();
      if (!value || !isMemoryScope(value)) {
        throw new Error("--scope must be personal or conversation");
      }
      scope = value;
      continue;
    }
    if (arg === "--scope-key") {
      const value = args.shift()?.trim();
      if (!value) {
        throw new Error("--scope-key requires a value");
      }
      scopeKey = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown memory search option: ${arg}`);
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!scope || !scopeKey) {
    throw new Error("memory search requires --scope and --scope-key");
  }

  return {
    limit,
    ...(query ? { query } : {}),
    scope,
    scopeKey,
    showContent,
  };
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 117)}...`;
}

function formatDate(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

function formatMemory(
  row: typeof juniorMemoryMemories.$inferSelect,
  args: {
    showContent: boolean;
  },
): string {
  const lines = [
    `id=${row.id}`,
    `scope=${row.scope}`,
    `scope_key=${row.scopeKey}`,
    `subject_type=${row.subjectType}`,
    ...(row.subjectKey ? [`subject_key=${row.subjectKey}`] : []),
    `type=${row.type}`,
    `created_at=${formatDate(row.createdAtMs)}`,
    `observed_at=${formatDate(row.observedAtMs)}`,
    `expires_at=${formatDate(row.expiresAtMs)}`,
    `archived_at=${formatDate(row.archivedAtMs)}`,
  ];
  if (args.showContent) {
    lines.push(`content=${row.content}`);
  } else {
    lines.push(`preview=${preview(row.content)}`);
  }
  return lines.join("\n");
}

async function runSearch(ctx: PluginCliCommandContext, argv: string[]) {
  const options = parseSearchArgs(argv);
  const nowMs = Date.now();
  const terms = [
    ...new Set(
      (options.query ?? "")
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
    `${rows.map((row) => formatMemory(row, options)).join("\n\n")}\n`,
  );
  return 0;
}

async function runShow(ctx: PluginCliCommandContext, argv: string[]) {
  const [id, ...rest] = argv;
  if (!id || rest.length > 0) {
    throw new Error("memory show requires exactly one memory id");
  }

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

/** Create the plugin-owned memory admin CLI command. */
export function createMemoryCliCommand(): PluginCliCommandDefinition {
  return {
    name: "memory",
    summary: "Inspect Junior memory state",
    usage: USAGE,
    async run(ctx) {
      const [subcommand, ...rest] = ctx.argv;
      try {
        if (subcommand === "search") {
          return await runSearch(ctx, rest);
        }
        if (subcommand === "show") {
          return await runShow(ctx, rest);
        }
        await ctx.io.writeError(`${USAGE}\n`);
        return 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.io.writeError(`${message}\n${USAGE}\n`);
        return 1;
      }
    },
  };
}
