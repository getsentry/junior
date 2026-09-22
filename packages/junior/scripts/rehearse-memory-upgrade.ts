/**
 * Rehearse the core Memory migration against real Postgres.
 *
 * For a fresh database and for every meaningful legacy Memory plugin prefix,
 * this script applies the pre-Memory core journal, the legacy plugin
 * migrations, representative legacy rows, and then `junior upgrade`. It checks
 * that every path ends with the same schema and data, and that a rerun makes
 * no changes.
 *
 * Usage:
 *   DATABASE_URL=postgres://junior:junior@localhost:54322/junior \
 *     pnpm --filter @sentry/junior exec tsx scripts/rehearse-memory-upgrade.ts
 */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import type { JuniorSqlExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

const MEMORY_MIGRATION_TAG = "0045_memory_core";
const CORE_MIGRATIONS = path.resolve(process.cwd(), "migrations");
/** The 12 migrations that the removed `@sentry/junior-memory` plugin shipped. */
const LEGACY_MIGRATIONS = path.resolve(
  process.cwd(),
  "scripts/fixtures/legacy-memory-migrations",
);
/** Legacy plugin journal prefixes worth rehearsing: before each data change. */
const LEGACY_PREFIXES = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12];
const APPLICATION_NAME = "junior-memory-rehearsal";

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

interface Fingerprint {
  columns: unknown[];
  constraints: unknown[];
  extensions: unknown[];
  indexes: unknown[];
}

function trimmedMigrationsDir(
  sourceDir: string,
  keep: (entry: Journal["entries"][number]) => boolean,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "junior-memory-rehearsal-"));
  cpSync(sourceDir, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  journal.entries = journal.entries.filter(keep);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}

async function fingerprint(sql: JuniorSqlExecutor): Promise<Fingerprint> {
  const tables = ["junior_memory_memories", "junior_memory_embeddings"];
  const columns = await sql.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, is_generated, generation_expression
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1)
     ORDER BY table_name, column_name`,
    [tables],
  );
  const constraints = await sql.query(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = ANY($1::regclass[])
     ORDER BY conrelid::regclass::text, conname`,
    [tables],
  );
  const indexes = await sql.query(
    `SELECT tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY($1)
     ORDER BY tablename, indexname`,
    [tables],
  );
  const extensions = await sql.query(
    `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'btree_gin') ORDER BY extname`,
  );
  return { columns, constraints, extensions, indexes };
}

function legacyRows(prefix: number): Array<Record<string, unknown>> {
  // Values mirror what the legacy plugin wrote at that journal position.
  const scoped = prefix <= 9;
  const userScopeKey = scoped ? "slack:T1:U1" : "user-1";
  return [
    {
      id: "memory-a",
      scope: scoped ? "personal" : "private",
      scope_key: userScopeKey,
      type: "preference",
      subject_type: "user",
      subject_key: userScopeKey,
      source_platform: "slack",
      source_key: "slack:T1:C1:1.1",
      idempotency_key: "k-a",
    },
    {
      id: "memory-b",
      scope: scoped ? "conversation" : "public",
      scope_key:
        prefix <= 3 ? "slack:T1:C1:1.1" : scoped ? "slack:T1" : "public",
      type: "knowledge",
      subject_type: "conversation",
      subject_key:
        prefix <= 3 ? "slack:T1:C1:1.1" : scoped ? "slack:T1" : "public",
      source_platform: "slack",
      source_key: "slack:T1:C1:1.1",
      idempotency_key: "k-b",
    },
    {
      id: "memory-c",
      scope: scoped ? "personal" : "private",
      scope_key: userScopeKey,
      type: prefix <= 4 ? "task" : "procedure",
      subject_type: "general",
      subject_key: null,
      source_platform: "local",
      source_key: "local:conversation-1",
      idempotency_key: "k-c",
    },
  ];
}

async function seedLegacyData(
  sql: JuniorSqlExecutor,
  prefix: number,
): Promise<void> {
  const now = new Date().toISOString();
  await sql.execute(
    `INSERT INTO junior_users (id, primary_email, primary_email_normalized, created_at, updated_at)
     VALUES ('user-1', 'one@example.com', 'one@example.com', $1, $1)`,
    [now],
  );
  await sql.execute(
    `INSERT INTO junior_identities (id, kind, provider, provider_tenant_id, provider_subject_id, created_at, updated_at, user_id)
     VALUES ('identity-1', 'user', 'slack', 'T1', 'U1', $1, $1, 'user-1')`,
    [now],
  );
  await sql.execute(
    `INSERT INTO junior_conversations (conversation_id, created_at, last_activity_at, updated_at, execution_status)
     VALUES ('slack:C1:1.1', $1, $1, $1, 'idle')`,
    [now],
  );
  await sql.execute(
    `INSERT INTO junior_conversation_events (conversation_id, seq, history_version, type, payload, created_at)
     VALUES ('slack:C1:1.1', 1, 1, 'structured_event', $1::jsonb, $2)`,
    [
      JSON.stringify({
        namespace: "memory",
        name: "memories_captured",
        version: 2,
        turnId: "turn-1",
        content: {
          memories: [
            {
              id: "memory-a",
              content: "Prefers terse updates.",
              kind: "preference",
              observedAtMs: 1,
              scope: prefix <= 10 ? "personal" : "private",
            },
          ],
        },
      }),
      now,
    ],
  );
  if (prefix === 0) {
    return;
  }
  for (const row of legacyRows(prefix)) {
    await sql.execute(
      `INSERT INTO junior_memory_memories
         (id, scope, scope_key, type, subject_type, subject_key, content, source_platform, source_key, idempotency_key, observed_at_ms, created_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 1)`,
      [
        row.id,
        row.scope,
        row.scope_key,
        row.type,
        row.subject_type,
        row.subject_key,
        `Content for ${String(row.id)}`,
        row.source_platform,
        row.source_key,
        row.idempotency_key,
      ],
    );
  }
}

async function expectRow(
  sql: JuniorSqlExecutor,
  id: string,
  expected: Record<string, unknown>,
): Promise<string[]> {
  const [row] = await sql.query<Record<string, unknown>>(
    `SELECT scope, scope_key, type, conversation_id, archived_at_ms FROM junior_memory_memories WHERE id = $1`,
    [id],
  );
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (row?.[key] !== value) {
      problems.push(
        `${id}.${key}: expected ${String(value)}, got ${String(row?.[key])}`,
      );
    }
  }
  return problems;
}

async function verifyData(
  sql: JuniorSqlExecutor,
  prefix: number,
): Promise<string[]> {
  // After legacy 0011, a missing conversation_id is a current row. Keep it.
  const conversationId = (value: string) => (prefix < 12 ? value : null);
  const problems = [
    ...(await expectRow(sql, "memory-a", {
      scope: "private",
      scope_key: "user-1",
      type: "preference",
      conversation_id: conversationId("slack:C1:1.1"),
      archived_at_ms: null,
    })),
    ...(await expectRow(sql, "memory-b", {
      scope: "public",
      scope_key: "public",
      type: "knowledge",
      conversation_id: conversationId("slack:C1:1.1"),
      archived_at_ms: null,
    })),
    ...(await expectRow(sql, "memory-c", {
      scope: "private",
      scope_key: "user-1",
      type: "procedure",
      conversation_id: conversationId("local:conversation-1"),
      archived_at_ms: null,
    })),
  ];
  const [event] = await sql.query<{ scope: string }>(
    `SELECT payload->'content'->'memories'->0->>'scope' AS scope
     FROM junior_conversation_events WHERE conversation_id = 'slack:C1:1.1'`,
  );
  if (event?.scope !== "private") {
    problems.push(`event scope: expected private, got ${String(event?.scope)}`);
  }
  return problems;
}

async function withAdmin<T>(
  adminUrl: string,
  callback: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    application_name: APPLICATION_NAME,
    connectionString: adminUrl,
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withAdmin(adminUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${name}"`),
  );
}

async function createDatabase(adminUrl: string, name: string): Promise<string> {
  await dropDatabase(adminUrl, name);
  await withAdmin(adminUrl, (client) =>
    client.query(`CREATE DATABASE "${name}"`),
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function rehearse(
  label: string,
  adminUrl: string,
  prepare: (sql: JuniorSqlExecutor) => Promise<void>,
  verifyPrefix: number | undefined,
): Promise<{ fingerprint: Fingerprint; problems: string[] }> {
  const databaseName = `junior_memory_rehearsal_${label}`;
  const url = await createDatabase(adminUrl, databaseName);
  const sql = createPostgresJuniorSqlExecutor({
    applicationName: APPLICATION_NAME,
    connectionString: url,
    statementTimeoutMs: false,
  });
  const problems: string[] = [];
  try {
    await prepare(sql);
    const first = await migrateSchema(sql);
    if (first.migrated === 0) {
      problems.push("first upgrade applied nothing");
    }
    if (verifyPrefix !== undefined) {
      problems.push(...(await verifyData(sql, verifyPrefix)));
    }
    const before = JSON.stringify(await fingerprint(sql));
    const second = await migrateSchema(sql);
    if (second.migrated !== 0) {
      problems.push(`rerun applied ${second.migrated} migrations`);
    }
    if (JSON.stringify(await fingerprint(sql)) !== before) {
      problems.push("rerun changed the schema");
    }
    return { fingerprint: JSON.parse(before) as Fingerprint, problems };
  } finally {
    await sql.close();
    await dropDatabase(adminUrl, databaseName);
  }
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const preMemoryCore = trimmedMigrationsDir(
    CORE_MIGRATIONS,
    (entry) => entry.tag !== MEMORY_MIGRATION_TAG,
  );
  const results: Array<{ label: string; problems: string[] }> = [];
  try {
    const fresh = await rehearse("fresh", adminUrl, async () => {}, undefined);
    results.push({ label: "fresh", problems: fresh.problems });
    const expected = JSON.stringify(fresh.fingerprint);
    for (const prefix of LEGACY_PREFIXES) {
      const legacyDir = trimmedMigrationsDir(
        LEGACY_MIGRATIONS,
        (entry) => entry.idx < prefix,
      );
      try {
        const result = await rehearse(
          `legacy_${prefix}`,
          adminUrl,
          async (sql) => {
            await sql.migrate({
              migrationsFolder: preMemoryCore,
              migrationsTable: "__drizzle_junior_core",
            });
            if (prefix > 0) {
              await migratePluginSchemas(sql, [
                { dir: legacyDir, pluginName: "memory" },
              ]);
            }
            await seedLegacyData(sql, prefix);
          },
          prefix > 0 ? prefix : undefined,
        );
        if (JSON.stringify(result.fingerprint) !== expected) {
          result.problems.push("final schema differs from a fresh database");
        }
        results.push({
          label: `legacy prefix ${prefix}`,
          problems: result.problems,
        });
      } finally {
        rmSync(legacyDir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(preMemoryCore, { recursive: true, force: true });
  }
  let failed = false;
  for (const result of results) {
    const status = result.problems.length === 0 ? "ok" : "FAILED";
    failed ||= result.problems.length > 0;
    console.log(`${status.padEnd(7)} ${result.label}`);
    for (const problem of result.problems) {
      console.log(`         - ${problem}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

await main();
