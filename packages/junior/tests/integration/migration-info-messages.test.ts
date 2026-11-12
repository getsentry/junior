import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createJuniorSqlExecutor } from "@/db/executor";
import {
  createEmptyJuniorPostgresFixture,
  hasJuniorPostgresTestDatabase,
} from "../fixtures/sql";

const PLUGIN_NAME = "info-message-test";
// The second CREATE makes Postgres send its own NOTICE, which the operator
// does not need to see.
const REPORTING_MIGRATION = `CREATE TABLE IF NOT EXISTS "info_message_items" ("id" integer PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "info_message_items" ("id" integer PRIMARY KEY);
--> statement-breakpoint
DO $$
BEGIN
  RAISE INFO 'repaired % rows', 3;
END $$;`;

describe.skipIf(!hasJuniorPostgresTestDatabase())(
  "migration info messages",
  () => {
    it("sends a migration's RAISE INFO report to the operator", async () => {
      const fixture = await createEmptyJuniorPostgresFixture();
      const messages: string[] = [];
      const sql = createJuniorSqlExecutor({
        connectionString: fixture.connectionString,
        driver: "postgres",
        onInfo: (message) => messages.push(message),
        statementTimeoutMs: false,
      });
      const dir = await mkdtemp(join(tmpdir(), "junior-info-messages-"));
      try {
        await mkdir(join(dir, "meta"), { recursive: true });
        await writeFile(join(dir, "0000_report.sql"), REPORTING_MIGRATION);
        await writeFile(
          join(dir, "meta", "_journal.json"),
          JSON.stringify({
            dialect: "postgresql",
            entries: [
              {
                breakpoints: true,
                idx: 0,
                tag: "0000_report",
                version: "7",
                when: 1000,
              },
            ],
            version: "7",
          }),
        );

        await migratePluginSchemas(sql, [{ dir, pluginName: PLUGIN_NAME }]);

        expect(messages).toEqual(["repaired 3 rows"]);
      } finally {
        await rm(dir, { force: true, recursive: true });
        await sql.close();
        await fixture.close();
      }
    });
  },
);
