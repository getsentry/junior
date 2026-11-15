import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { getConversationEventStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const DAY_MS = 24 * 60 * 60 * 1_000;

const backfill = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
})
  .flatMap((migration) => migration.sql)
  .find((statement) =>
    statement.includes('INSERT INTO "junior_conversation_links"'),
  );

// Text that tests each rule of the URL pattern: Slack and Markdown wrappers,
// quotes, every whitespace that JavaScript `\s` matches, and non-ASCII paths.
const texts = [
  "See https://a.example/x?y=1, then <https://b.example/p|label> and (https://c.example/q).",
  "No-break\u00a0https://d.example/a\u00a0tail, em\u2003https://e.example/b\u2028x, wide\u3000https://f.example/c\ufeffz",
  "Tab\thttps://g.example/\tnl\nhttp://h.example/x\rvt\u000bhttps://i.example/\u000cff",
  "Quotes \"https://j.example/q\" 'https://k.example/s' `https://l.example/t`",
  "Paths https://m.example/путь/😀?q=é, not httpx://no or https:// alone",
  "Upper HTTPS://upper.example/ pipes https://n.example/a|b https://o.example/a>b",
  "Zero-width https://p.example/a\u200bb narrow\u202fhttps://q.example/ next\u0085https://s.example/",
  "Glued https://t.example/https://u.example/ end",
];

type LinkRow = {
  conversationId: string;
  position: number;
  seq: number;
  url: string;
};

describe("conversation links migration", () => {
  it("fills the same link rows as the write path, for recent Conversations only", async () => {
    if (!backfill) throw new Error("Conversation links backfill not found");
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const recentId = "slack:C123:recent";
      const oldId = "slack:C123:old";
      for (const conversationId of [recentId, oldId]) {
        await store.recordActivity({
          conversationId,
          nowMs: Date.now(),
          destination: { platform: "slack", teamId: "T123", channelId: "C123" },
          visibility: "public",
        });
      }
      const mentions = [undefined, false, true, "false", undefined];
      for (const [index, text] of texts.entries()) {
        const explicitMention = mentions[index % mentions.length];
        await getConversationEventStore().append(recentId, [
          {
            createdAtMs: Date.now(),
            data: {
              messageId: `message-${index}`,
              role: index % 2 === 0 ? "user" : "assistant",
              text,
              type: "message",
              ...(explicitMention === undefined
                ? undefined
                : { meta: { explicitMention } }),
            },
          },
        ]);
      }
      // An edit replaces the links of its message, at the seq of the first
      // save. Updates carry the message's meta, as `messages.ts` writes them.
      const edit = (index: number, text: string) => {
        const explicitMention = mentions[index % mentions.length];
        return {
          createdAtMs: Date.now(),
          data: {
            messageId: `message-${index}`,
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text,
            type: "message_updated" as const,
            ...(explicitMention === undefined
              ? undefined
              : { meta: { explicitMention } }),
          },
        };
      };
      await getConversationEventStore().append(recentId, [
        edit(0, "Edited to https://edited.example/zero only"),
        edit(2, "First edit https://edited.example/first"),
      ]);
      await getConversationEventStore().append(recentId, [
        edit(
          2,
          "Second edit https://edited.example/second and https://edited.example/third",
        ),
        edit(5, "Edited away"),
      ]);
      await getConversationEventStore().append(oldId, [
        {
          createdAtMs: Date.now(),
          data: {
            messageId: "old-message",
            role: "user",
            text: "Old https://old.example/",
            type: "message",
          },
        },
      ]);
      await fixture.sql.execute(
        `UPDATE junior_conversations SET last_activity_at = $1 WHERE conversation_id = $2`,
        [new Date(Date.now() - 31 * DAY_MS), oldId],
      );
      const readRows = () =>
        fixture.sql.query<LinkRow>(`
SELECT conversation_id AS "conversationId", seq, position, url
FROM junior_conversation_links
ORDER BY conversation_id, seq, position
`);
      const written = await readRows();
      expect(written.filter((row) => row.conversationId === oldId)).toEqual([
        expect.objectContaining({ url: "https://old.example/" }),
      ]);
      const recentWritten = written.filter(
        (row) => row.conversationId === recentId,
      );
      // The "false" mention rule drops 3 of the 8 messages, and message 5
      // lost its links in an edit.
      expect(new Set(recentWritten.map((row) => row.seq)).size).toBe(4);
      const urlsOf = (seq: number | undefined) =>
        recentWritten.filter((row) => row.seq === seq).map((row) => row.url);
      const seqs = [...new Set(recentWritten.map((row) => row.seq))];
      expect(urlsOf(seqs[0])).toEqual(["https://edited.example/zero"]);
      expect(urlsOf(seqs[1])).toEqual([
        "https://edited.example/second",
        "https://edited.example/third",
      ]);
      expect(recentWritten).toContainEqual(
        expect.objectContaining({ url: "https://m.example/путь/😀?q=é," }),
      );

      await fixture.sql.execute(`DELETE FROM junior_conversation_links`);
      await fixture.sql.execute(backfill);
      expect(await readRows()).toEqual(recentWritten);
      // A second run inserts nothing new.
      await fixture.sql.execute(backfill);
      expect(await readRows()).toEqual(recentWritten);
    } finally {
      await fixture.close();
    }
  });
});
