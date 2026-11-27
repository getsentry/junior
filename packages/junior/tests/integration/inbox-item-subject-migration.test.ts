import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const migration = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
}).find((entry) =>
  entry.sql.some((statement) =>
    statement.includes('CREATE TRIGGER "junior_inbox_items_legacy_subject"'),
  ),
);
// The steps of the `inbox_item_subjects` migration that close the open items that now share a subject,
// up to the unique index that keeps one open item for each subject.
const start =
  migration?.sql.findIndex((statement) =>
    statement.includes("'A newer item asks about the same subject.'"),
  ) ?? -1;
const end =
  migration?.sql.findIndex((statement) =>
    statement.includes(
      'CREATE UNIQUE INDEX "junior_inbox_items_open_subject_uidx"',
    ),
  ) ?? -1;

const PULL_REQUEST = "getsentry/junior#946";

/** Add an open item as a worker of the last release does: with no subject. */
function legacyItem(id: string, prefix: string, updatedAt: string): string {
  return `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, owner_id, created_at, updated_at) VALUES ('${id}', 'action', 'open', 'public', 'PR #946', 'GitHub asks about #946.', 'plugin:github:${prefix}:${PULL_REQUEST}', 'slack:C123:1.000001', '${updatedAt}', '${updatedAt}')`;
}

/** Add an agent's open question as a worker of the last release does. */
function legacyQuestion(id: string, key: string): string {
  return `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_id, owner_id, created_at, updated_at, request) VALUES ('${id}', 'action', 'open', 'public', 'Roll out?', 'The canary is clean.', '${key}', 'release:payments-v42', 'slack:C123:1.000002', now(), now(), '{"question":"Roll out?","fields":[]}')`;
}

describe("inbox item subject migration", () => {
  it("keeps one open item for each subject, with the assignees and snoozes and without the pushes of the items it closes", async () => {
    if (!migration || start < 0 || end < start) {
      throw new Error("inbox_item_subjects migration steps not found");
    }
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      // Before the `inbox_questions` migration, a question item keeps its
      // own content. `inbox-question-migration.test.ts` covers that step.
      await fixture.sql.execute(
        `ALTER TABLE junior_inbox_items DISABLE TRIGGER junior_inbox_items_legacy_subject_question`,
      );
      // Before that migration, the old dedupe keys of one pull request's asks differ.
      await fixture.sql.execute(
        `DROP INDEX "junior_inbox_items_open_subject_key_uidx"`,
      );
      for (const user of ["ana", "ben"]) {
        await fixture.sql.execute(
          `INSERT INTO junior_users (id, primary_email, primary_email_normalized, created_at, updated_at) VALUES ('user:${user}', '${user}@example.com', '${user}@example.com', now(), now())`,
        );
      }
      await fixture.sql.execute(
        legacyItem(
          "review",
          "pull-request-review-requested",
          "2026-10-01T12:00:00Z",
        ),
      );
      await fixture.sql.execute(
        legacyItem("merge", "pull-request-ready", "2026-10-02T12:00:00Z"),
      );
      // Ana has the review ask and Ben the merge ask.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_item_assignees (item_id, user_id) VALUES ('review', 'user:ana'), ('merge', 'user:ben')`,
      );
      // Ana snoozed only the review ask. Ben snoozed both asks.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_snoozes (id, user_id, inbox_item_id, state, created_at) VALUES ('ana-review', 'user:ana', 'review', 'snoozed', now()), ('ben-review', 'user:ben', 'review', 'snoozed', now()), ('ben-merge', 'user:ben', 'merge', 'snoozed', now())`,
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_item_deliveries (item_id, user_id, channel, event, status, created_at, updated_at) VALUES ('review', 'user:ana', 'web_push', 'created', 'sent', now(), now()), ('merge', 'user:ben', 'web_push', 'created', 'sent', now(), now())`,
      );

      // Two questions about one release had their own keys.
      await fixture.sql.execute(legacyQuestion("rollout", "rollout:v42"));
      await fixture.sql.execute(legacyQuestion("hold", "hold:v42"));
      // A question about a pull request had that link as its subject.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_url, subject_title, owner_id, created_at, updated_at, request) VALUES ('ship', 'action', 'open', 'public', 'Ship it?', 'Checks are green.', 'ship:946', 'https://github.com/${PULL_REQUEST.replace("#", "/pull/")}', 'PR #946', 'slack:C123:1.000003', now(), now(), '{"question":"Ship it?","fields":[],"evidence":[{"label":"CI run","url":"https://ci.example.com/1"}]}')`,
      );

      // Another kept the link of its pull request as its subject id. Its
      // links have an upper case scheme or host, or no path.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_id, owner_id, created_at, updated_at, request) VALUES ('deploy', 'action', 'open', 'public', 'Deploy it?', 'It merged.', 'deploy:947', 'https://GitHub.com/getsentry/junior/pull/947', 'slack:C123:1.000004', now(), now(), '{"question":"Deploy it?","fields":[],"evidence":[{"label":"Docs","url":"HTTPS://Docs.Example.com?page=Deploy"},{"label":"Dashboard","url":"https://Dash.Example.com"}]}')`,
      );

      // A closed question already cites its subject link, in a form that
      // new code does not store.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_url, owner_id, created_at, updated_at, closed_at, request) VALUES ('shipped', 'action', 'done', 'public', 'Ship the site?', 'It is live.', 'shipped:site', 'https://Example.com', 'slack:C123:1.000005', now(), now(), now(), '{"question":"Ship the site?","fields":[],"evidence":[{"label":"Site","url":"https://Example.com"}]}')`,
      );
      // A notice had no request, only its subject link.
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, subject_url, subject_title, owner_id, created_at, updated_at) VALUES ('heads-up', 'notice', 'open', 'public', 'Docs moved', 'The guide has a new home.', 'docs:moved', 'https://Docs.Example.com/guide', 'New guide', 'slack:C123:1.000006', now(), now())`,
      );

      for (const statement of migration.sql.slice(start, end + 1)) {
        await fixture.sql.execute(statement);
      }

      expect(
        await fixture.sql.query(
          `SELECT id, status FROM junior_inbox_items ORDER BY id`,
        ),
      ).toEqual([
        { id: "deploy", status: "open" },
        { id: "heads-up", status: "open" },
        { id: "hold", status: "open" },
        { id: "merge", status: "open" },
        { id: "review", status: "dismissed" },
        { id: "rollout", status: "open" },
        { id: "ship", status: "open" },
        { id: "shipped", status: "done" },
      ]);
      // A question's key names it, so both questions stay open.
      expect(
        await fixture.sql.query(
          `SELECT id, subject_kind, subject_id FROM junior_inbox_items WHERE subject_kind = 'question' ORDER BY id`,
        ),
      ).toEqual([
        { id: "deploy", subject_id: "deploy:947", subject_kind: "question" },
        {
          id: "heads-up",
          subject_id: "docs:moved",
          subject_kind: "question",
        },
        { id: "hold", subject_id: "hold:v42", subject_kind: "question" },
        { id: "rollout", subject_id: "rollout:v42", subject_kind: "question" },
        { id: "ship", subject_id: "ship:946", subject_kind: "question" },
        { id: "shipped", subject_id: "shipped:site", subject_kind: "question" },
      ]);
      // Its old subject link is now its first evidence link, so its card
      // still lists the pull request.
      expect(
        await fixture.sql.query(
          `SELECT request->'evidence' AS evidence FROM junior_inbox_items WHERE id = 'ship'`,
        ),
      ).toEqual([
        {
          evidence: [
            {
              label: "PR #946",
              url: "https://github.com/getsentry/junior/pull/946",
            },
            { label: "CI run", url: "https://ci.example.com/1" },
          ],
        },
      ]);
      expect(
        await fixture.sql.query(
          `SELECT request->'evidence' AS evidence FROM junior_inbox_items WHERE id = 'deploy'`,
        ),
      ).toEqual([
        {
          // They get the form that new code stores, `URL.href`.
          evidence: [
            {
              label: "https://github.com/getsentry/junior/pull/947",
              url: "https://github.com/getsentry/junior/pull/947",
            },
            {
              label: "Docs",
              url: "https://docs.example.com/?page=Deploy",
            },
            { label: "Dashboard", url: "https://dash.example.com/" },
          ],
        },
      ]);
      // A notice keeps no request, because the old kind check still holds.
      // Its old subject link stays in `subject_url` in the stored form, and
      // its question reads it from there.
      expect(
        await fixture.sql.query(
          `SELECT request, subject_url FROM junior_inbox_items WHERE id = 'heads-up'`,
        ),
      ).toEqual([
        { request: null, subject_url: "https://docs.example.com/guide" },
      ]);
      // A closed item's links get the same form, so its subject link is no
      // second copy of the link that it cites.
      expect(
        await fixture.sql.query(
          `SELECT request->'evidence' AS evidence FROM junior_inbox_items WHERE id = 'shipped'`,
        ),
      ).toEqual([
        { evidence: [{ label: "Site", url: "https://example.com/" }] },
      ]);
      // Ana joins the item that stays open, so she keeps her ask.
      expect(
        await fixture.sql.query(
          `SELECT user_id FROM junior_inbox_item_assignees WHERE item_id = 'merge' ORDER BY user_id`,
        ),
      ).toEqual([{ user_id: "user:ana" }, { user_id: "user:ben" }]);
      // Ana's snooze still hides the item that stays open. Ben keeps his
      // own snooze of it.
      expect(
        await fixture.sql.query(
          `SELECT id, inbox_item_id, state FROM junior_inbox_snoozes WHERE state = 'snoozed' AND inbox_item_id = 'merge' ORDER BY id`,
        ),
      ).toEqual([
        { id: "ana-review", inbox_item_id: "merge", state: "snoozed" },
        { id: "ben-merge", inbox_item_id: "merge", state: "snoozed" },
      ]);
      // The devices close the push of the closed item, as for any close.
      expect(
        await fixture.sql.query(
          `SELECT item_id, status FROM junior_inbox_item_deliveries ORDER BY item_id`,
        ),
      ).toEqual([
        { item_id: "merge", status: "sent" },
        { item_id: "review", status: "cleared" },
      ]);
      // A worker of the last release cannot add a second open item for the
      // pull request while this release rolls out.
      await expect(
        fixture.sql.execute(
          legacyItem("action", "pull-request-action", "2026-10-03T12:00:00Z"),
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      // The worker database outlives this test, so undo the schema changes:
      // the trigger and index that it removed, and the index of the older
      // migration that it ran.
      await fixture.sql.execute(
        `DROP INDEX IF EXISTS "junior_inbox_items_open_subject_uidx"`,
      );
      await fixture.sql.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS "junior_inbox_items_open_subject_key_uidx" ON "junior_inbox_items" USING btree ("subject_kind","subject_id") WHERE "junior_inbox_items"."status" = 'open'`,
      );
      await fixture.sql.execute(
        `ALTER TABLE junior_inbox_items ENABLE TRIGGER junior_inbox_items_legacy_subject_question`,
      );
      await fixture.close();
    }
  });

  it("finds a pull request's GitHub id through its Conversation after a repository rename", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const change = (
        id: string,
        repository: string,
        number: number,
        conversationId: string,
      ) =>
        fixture.sql.execute(
          `INSERT INTO junior_code_changes (id, conversation_ids, number, opened_at, provider, provider_id, repository_id, state, updated_at) VALUES (gen_random_uuid(), ARRAY['${conversationId}'], ${number}, now(), 'github', '${id}', '${repository}', 'open', now())`,
        );
      // The repository of #946 was renamed after Junior opened it.
      await fixture.sql.execute(
        `INSERT INTO junior_code_repositories (id, name, provider, provider_id, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'getsentry/junior-next', 'github', 'R_1', now()), ('00000000-0000-4000-8000-000000000002', 'getsentry/other', 'github', 'R_2', now())`,
      );
      await change(
        "PR_946",
        "00000000-0000-4000-8000-000000000001",
        946,
        "slack:C123:1.000001",
      );
      // Another Conversation opened #950 in two repositories, so the number
      // names no one change.
      await change(
        "PR_950_A",
        "00000000-0000-4000-8000-000000000001",
        950,
        "slack:C123:1.000009",
      );
      await change(
        "PR_950_B",
        "00000000-0000-4000-8000-000000000002",
        950,
        "slack:C123:1.000009",
      );

      // Workers of the last release add the asks with the old name.
      await fixture.sql.execute(
        legacyItem(
          "renamed",
          "pull-request-review-requested",
          "2026-10-01T12:00:00Z",
        ),
      );
      await fixture.sql.execute(
        `INSERT INTO junior_inbox_items (id, kind, status, visibility, title, body, dedupe_key, owner_id, created_at, updated_at) VALUES ('ambiguous', 'action', 'open', 'public', 'PR #950', 'GitHub asks about #950.', 'plugin:github:pull-request-ready:getsentry/junior#950', 'slack:C123:1.000009', now(), now())`,
      );

      expect(
        await fixture.sql.query(
          `SELECT id, subject_kind, subject_id FROM junior_inbox_items ORDER BY id`,
        ),
      ).toEqual([
        {
          id: "ambiguous",
          subject_id: "getsentry/junior#950",
          subject_kind: "github:pull_request",
        },
        {
          id: "renamed",
          subject_id: "PR_946",
          subject_kind: "github:pull_request",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
