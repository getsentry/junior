import { createHash } from "node:crypto";
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
    statement.includes('INSERT INTO "junior_message_attachments"'),
  );

// A link too long for a btree index entry. Hex digests do not compress, so
// the index cannot fit it by compression.
const longUrl = `https://long.example/${Array.from({ length: 50 }, (_, index) =>
  createHash("sha256").update(String(index)).digest("hex"),
).join("")}`;

// Text that tests each rule of the URL pattern: Slack and Markdown wrappers,
// quotes, every whitespace that JavaScript `\s` matches, and non-ASCII paths.
const texts = [
  "See https://a.example/x?y=1, then <https://b.example/p|label> and (https://c.example/q).",
  "No-break\u00a0https://d.example/a\u00a0tail, em\u2003https://e.example/b\u2028x, wide\u3000https://f.example/c\ufeffz",
  "Tab\thttps://g.example/\tnl\nhttp://h.example/x\rvt\u000bhttps://i.example/\u000cff",
  "Quotes \"https://j.example/q\" 'https://k.example/s' `https://l.example/t`",
  `Paths https://m.example/путь/😀?q=é, not httpx://no or https:// alone, too long ${longUrl}`,
  "Upper HTTPS://upper.example/ pipes https://n.example/a|b https://o.example/a>b",
  "Zero-width https://p.example/a\u200bb narrow\u202fhttps://q.example/ next\u0085https://s.example/",
  "Glued https://t.example/https://u.example/ end",
  "Not for Junior https://x.example/ at all",
  "Twice https://v.example/ and https://v.example/. then https://w.example/a?).",
];

type LinkRow = {
  attachmentId: string;
  conversationId: string;
  kind: string;
  position: number | null;
  seq: number;
  url: string;
};

describe("attachment url fill migration", () => {
  it("fills the same url Attachments as the write path, for recent Conversations only", async () => {
    if (!backfill) throw new Error("Attachment url fill not found");
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
SELECT m.conversation_id AS "conversationId", m.seq, m.position,
  m.attachment_id AS "attachmentId", a.kind, a.url
FROM junior_message_attachments m
JOIN junior_attachments a
  ON a.id = m.attachment_id AND a.conversation_id = m.conversation_id
ORDER BY m.conversation_id, m.seq, m.position
`);
      const written = await readRows();
      expect(written.filter((row) => row.conversationId === oldId)).toEqual([
        expect.objectContaining({ url: "https://old.example/" }),
      ]);
      const recentWritten = written.filter(
        (row) => row.conversationId === recentId,
      );
      // The "false" mention rule drops 4 of the 10 messages, and message 5
      // lost its links in an edit.
      expect(new Set(recentWritten.map((row) => row.seq)).size).toBe(5);
      const urlsOf = (seq: number | undefined) =>
        recentWritten.filter((row) => row.seq === seq).map((row) => row.url);
      const seqs = [...new Set(recentWritten.map((row) => row.seq))];
      expect(urlsOf(seqs[0])).toEqual(["https://edited.example/zero"]);
      expect(urlsOf(seqs[1])).toEqual([
        "https://edited.example/second",
        "https://edited.example/third",
      ]);
      expect(recentWritten).toContainEqual(
        expect.objectContaining({ url: "https://m.example/путь/😀?q=é" }),
      );
      expect(recentWritten.map((row) => row.url)).not.toContain(longUrl);
      // A repeat in one message keeps its first position, and trailing
      // punctuation is not part of a link.
      expect(urlsOf(seqs[4])).toEqual([
        "https://v.example/",
        "https://w.example/a",
      ]);
      expect(
        recentWritten
          .filter((row) => row.seq === seqs[4])
          .map((row) => row.position),
      ).toEqual([1, 3]);

      await fixture.sql.execute(`DELETE FROM junior_message_attachments`);
      await fixture.sql.execute(
        `DELETE FROM junior_attachments WHERE kind = 'url'`,
      );
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
