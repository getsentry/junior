/**
 * Sent links: the web links that a person sends to Junior, from Slack, the
 * dashboard, or an MCP client, go to the Conversation's linked work.
 *
 * The transaction that stores a `turn_started` event gives each link of the
 * Turn's input Messages that a person wrote a due time
 * (`queueTurnInputLinks`), so the work is stored before it runs. Each
 * heartbeat attaches a bounded slice of due links as their author, with the
 * rule of the dashboard attach (`object-attach.ts`). The claim moves a
 * link's due time ahead by the retry delay. A run that dies leaves its claims
 * for a later heartbeat, and a failed attach is tried again until its
 * Message is an hour old. Links that were stored before the due time existed
 * have none, so they are never attached.
 *
 * Attributes on the `sent_links.attach` span:
 * - `app.sent_links.claimed.count`: links that the run claimed.
 * - `app.sent_links.attached.count`: links that it added to linked work.
 * - `app.sent_links.failed.count`: links whose attach threw.
 * Policy: policies/observability.md.
 */
import { and, asc, eq, lte, or } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import { logException, withSpan } from "@/chat/logging";
import { readIdentityById } from "@/chat/plugins/viewer";
import {
  juniorAttachments,
  juniorConversationEvents,
  juniorMessageAttachments,
} from "@/db/schema";
import { attachObjectLinkForUser } from "./object-attach";

// Each link can read a provider, so one run attaches a few.
const MAX_LINKS_PER_RUN = 25;
const RETRY_DELAY_MS = 10 * 60_000;
const MAX_AGE_MS = 60 * 60_000;

type LinkKey = { attachmentId: string; conversationId: string; seq: number };

function linkId(key: LinkKey): string {
  return JSON.stringify([key.conversationId, key.seq, key.attachmentId]);
}

function linkWhere(keys: readonly LinkKey[]) {
  const m = juniorMessageAttachments;
  return or(
    ...keys.map((key) =>
      and(
        eq(m.conversationId, key.conversationId),
        eq(m.seq, key.seq),
        eq(m.attachmentId, key.attachmentId),
      ),
    ),
  );
}

/**
 * Attach the due sent links of every Conversation, oldest due first, each as
 * the person who wrote its Message. A link whose author has no User, or
 * that the rule refuses, is done without an attach.
 */
export async function attachSentLinks(nowMs: number): Promise<void> {
  await withSpan(
    "sent_links.attach",
    "sent_links.attach",
    {},
    async (setSpanAttributes) => {
      const db = getDb();
      const m = juniorMessageAttachments;
      const a = juniorAttachments;
      const e = juniorConversationEvents;
      const now = new Date(nowMs);
      const due = await db
        .select({
          actorIdentityId: e.actorIdentityId,
          attachmentId: m.attachmentId,
          conversationId: m.conversationId,
          messageCreatedAt: e.createdAt,
          seq: m.seq,
          url: a.url,
        })
        .from(m)
        .leftJoin(a, eq(a.id, m.attachmentId))
        .leftJoin(
          e,
          and(eq(e.conversationId, m.conversationId), eq(e.seq, m.seq)),
        )
        .where(lte(m.attachDueAt, now))
        .orderBy(asc(m.attachDueAt))
        .limit(MAX_LINKS_PER_RUN);
      if (due.length === 0) return;
      // A run that overlaps this one claims only the links that are still
      // due, so each claim has one owner.
      const claimed = await db
        .update(m)
        .set({ attachDueAt: new Date(nowMs + RETRY_DELAY_MS) })
        .where(and(lte(m.attachDueAt, now), linkWhere(due)))
        .returning({
          attachmentId: m.attachmentId,
          conversationId: m.conversationId,
          seq: m.seq,
        });
      const owned = new Set(claimed.map(linkId));
      const links = due.filter((link) => owned.has(linkId(link)));
      const done: LinkKey[] = [];
      let attached = 0;
      let failed = 0;
      await mapBounded(links, async (link) => {
        try {
          // Never attach as anyone but the author.
          const author =
            link.actorIdentityId &&
            (await readIdentityById(link.actorIdentityId))?.user;
          if (
            link.url &&
            author &&
            (await attachObjectLinkForUser(
              author,
              link.conversationId,
              link.url,
            )) === "attached"
          ) {
            attached += 1;
          }
          done.push(link);
        } catch (error) {
          failed += 1;
          logException(error, "sent_links.attach.failed", {
            "gen_ai.conversation.id": link.conversationId,
          });
          const ageMs = nowMs - (link.messageCreatedAt?.getTime() ?? 0);
          if (ageMs >= MAX_AGE_MS) done.push(link);
        }
      });
      if (done.length > 0) {
        await db.update(m).set({ attachDueAt: null }).where(linkWhere(done));
      }
      setSpanAttributes({
        "app.sent_links.attached.count": attached,
        "app.sent_links.claimed.count": links.length,
        "app.sent_links.failed.count": failed,
      });
    },
  );
}
