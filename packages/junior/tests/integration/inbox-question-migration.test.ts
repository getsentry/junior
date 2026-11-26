import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const migration = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
}).find((entry) =>
  entry.sql.some((statement) =>
    statement.includes(
      'CREATE TRIGGER "junior_inbox_items_legacy_subject_question"',
    ),
  ),
);
// The steps of the `inbox_questions` migration that delete the question
// items without an owner Conversation and move each other question item's
// content to its question.
const check =
  migration?.sql.findIndex((statement) =>
    statement.includes('DELETE FROM "junior_inbox_items"'),
  ) ?? -1;
const backfill =
  migration?.sql.findIndex((statement) =>
    statement.includes('UPDATE "junior_inbox_items" SET "subject_id" = "id"'),
  ) ?? -1;

const REQUEST = `{"question":"Roll out?","fields":[],"evidence":[{"label":"Canary","url":"https://ci.example.com/1"}]}`;
// The item keeps its own copy for the release before this one.
const ITEM_REQUEST = JSON.parse(REQUEST);
// The question keeps the request, with its `evidence` links as `related`.
const MOVED_REQUEST = {
  question: "Roll out?",
  fields: [],
  related: [{ label: "Canary", url: "https://ci.example.com/1" }],
};

/** Add a question item as it was before the migration: with its content. */
function legacyQuestion(
  id: string,
  owner: string,
  extra: { closed?: boolean; kind?: "action" | "notice" } = {},
): string {
  const kind = extra.kind ?? "action";
  const request = kind === "action" ? `'${REQUEST}'` : "NULL";
  const answer = extra.closed ? `'{"values":{"go":["Yes"]}}'` : "NULL";
  const status = extra.closed ? "done" : "open";
  const closedAt = extra.closed ? "now()" : "NULL";
  // A notice keeps its link in `subject_url`.
  const link = kind === "notice" ? `'https://ci.example.com/2'` : "NULL";
  return `INSERT INTO junior_inbox_items (id, kind, status, closed_at, visibility, title, body, subject_kind, subject_id, dedupe_key, subject_url, owner_id, added_by_turn_id, created_at, updated_at, request, answer) VALUES ('${id}', '${kind}', '${status}', ${closedAt}, 'public', 'Roll out ${id}?', 'The canary is clean.', 'question', 'key:${id}', 'key:${id}', ${link}, '${owner}', 'turn-${id}', '2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z', ${request}, ${answer})`;
}

function conversation(id: string): string {
  return `INSERT INTO junior_conversations (conversation_id, created_at, last_activity_at, updated_at, execution_status, root_conversation_id) VALUES ('${id}', now(), now(), now(), 'idle', '${id}')`;
}

describe("inbox question migration", () => {
  it("moves each question item's content to its question, also from a worker of the last release", async () => {
    if (!migration || check < 0 || backfill < check) {
      throw new Error("inbox_questions migration steps not found");
    }
    const fixture = createConfiguredJuniorSqlFixture();
    const run = async () => {
      for (const statement of migration.sql.slice(check, backfill + 1)) {
        await fixture.sql.execute(statement);
      }
    };
    try {
      await migrateSchema(fixture.sql);
      await fixture.sql.execute(conversation("slack:C123:1.000001"));
      // Rows from before the migration keep their content on the item.
      await fixture.sql.execute(
        `ALTER TABLE junior_inbox_items DISABLE TRIGGER junior_inbox_items_legacy_subject_question`,
      );
      await fixture.sql.execute(
        legacyQuestion("rollout", "slack:C123:1.000001"),
      );
      await fixture.sql.execute(
        legacyQuestion("shipped", "slack:C123:1.000001", { closed: true }),
      );
      await fixture.sql.execute(
        legacyQuestion("heads-up", "slack:C123:1.000001", { kind: "notice" }),
      );
      // A question needs its Conversation, so the migration deletes a
      // question item whose owner is gone.
      await fixture.sql.execute(legacyQuestion("lost", "slack:CGONE:1.000001"));
      await fixture.sql.execute(
        `ALTER TABLE junior_inbox_items ENABLE TRIGGER junior_inbox_items_legacy_subject_question`,
      );

      await run();

      // Each question takes its item's id, and the item points at it. The
      // item keeps its own copy of the content, because the release before
      // this one still reads it.
      expect(
        await fixture.sql.query(
          `SELECT id, subject_id, title, body, request, answer FROM junior_inbox_items ORDER BY id`,
        ),
      ).toEqual(
        [
          { answer: null, request: null, id: "heads-up" },
          { answer: null, request: ITEM_REQUEST, id: "rollout" },
          {
            answer: { values: { go: ["Yes"] } },
            request: ITEM_REQUEST,
            id: "shipped",
          },
        ].map((row) => ({
          ...row,
          body: "The canary is clean.",
          subject_id: row.id,
          title: `Roll out ${row.id}?`,
        })),
      );
      expect(
        await fixture.sql.query(
          `SELECT id, conversation_id, turn_id, title, body, request, answer FROM junior_questions ORDER BY id`,
        ),
      ).toEqual([
        {
          answer: null,
          body: "The canary is clean.",
          conversation_id: "slack:C123:1.000001",
          id: "heads-up",
          // The notice's link becomes its one related link.
          request: {
            related: [
              {
                label: "https://ci.example.com/2",
                url: "https://ci.example.com/2",
              },
            ],
          },
          title: "Roll out heads-up?",
          turn_id: "turn-heads-up",
        },
        {
          answer: null,
          body: "The canary is clean.",
          conversation_id: "slack:C123:1.000001",
          id: "rollout",
          request: MOVED_REQUEST,
          title: "Roll out rollout?",
          turn_id: "turn-rollout",
        },
        {
          answer: { values: { go: ["Yes"] } },
          body: "The canary is clean.",
          conversation_id: "slack:C123:1.000001",
          id: "shipped",
          request: MOVED_REQUEST,
          title: "Roll out shipped?",
          turn_id: "turn-shipped",
        },
      ]);

      // A worker of the last release adds a question with a dedupe key. It
      // gets a question with the item's id.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, owner_id, created_at, updated_at, request) VALUES ('late', 'action', 'open', 'public', 'Hold v42?', 'A test is flaky.', 'hold:v42', 'slack:C123:1.000001', now(), now(), '${REQUEST}')`,
      );
      // It changes the question by its key and then closes it with an
      // answer, as that release does.
      await fixture.sql.execute(
        `UPDATE junior_inbox_items SET title = 'Hold v42 now?', body = 'Two tests are flaky.', request = '${REQUEST}' WHERE id = 'late'`,
      );
      await fixture.sql.execute(
        `UPDATE junior_inbox_items SET status = 'done', closed_at = now(), answer = '{"values":{"go":["No"]}}' WHERE id = 'late'`,
      );
      expect(
        await fixture.sql.query(
          `SELECT subject_kind, subject_id, title, answer FROM junior_inbox_items WHERE id = 'late'`,
        ),
      ).toEqual([
        {
          answer: { values: { go: ["No"] } },
          subject_id: "late",
          subject_kind: "question",
          title: "Hold v42 now?",
        },
      ]);
      expect(
        await fixture.sql.query(
          `SELECT title, body, request, answer FROM junior_questions WHERE id = 'late'`,
        ),
      ).toEqual([
        {
          answer: { values: { go: ["No"] } },
          body: "Two tests are flaky.",
          request: MOVED_REQUEST,
          title: "Hold v42 now?",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
