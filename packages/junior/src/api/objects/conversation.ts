import type { ObjectAnnotation, User } from "@sentry/junior-plugin-api";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import {
  getDashboardConversationLink,
  parseDashboardConversationLink,
} from "@/chat/dashboard-link";
import { getConversationStore, getDb } from "@/chat/db";
import { readConversationAccessFromSql } from "../conversations/access";
import { readFirstHumanMessageTexts } from "../conversations/first-message";
import { readConversationParticipants } from "../conversations/participants";
import { conversationSummaryFromStoredConversation } from "../conversations/projection";
import { conversationObjectCard } from "./cards";

/**
 * Resolve a dashboard Conversation link for the viewer. The viewer sees the
 * card only where they see the Conversation's private content: a public
 * Conversation, or a private one that they take part in. Any other link
 * returns nothing, the same as a link to no Conversation.
 */
export async function resolveConversationLink(
  viewer: User,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const conversationId = parseDashboardConversationLink(url.href);
  const canonicalUrl = conversationId
    ? getDashboardConversationLink(conversationId)
    : undefined;
  if (!conversationId || !canonicalUrl) return undefined;
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) return undefined;
  const db = getDb();
  const access = (
    await readConversationAccessFromSql(db, [conversationId], viewer)
  ).get(conversationId);
  if (!access?.canViewPrivateContent) return undefined;

  const [firstTexts, automationTitles, brief, participants] = await Promise.all(
    [
      readFirstHumanMessageTexts(db, [conversation]),
      readAutomationTitlesByConversationId([conversation]),
      readLatestConversationBrief(db, conversationId),
      readConversationParticipants(db, [conversationId]),
    ],
  );
  return conversationObjectCard({
    brief: brief?.content.summary,
    participants: participants.get(conversationId) ?? [],
    summary: conversationSummaryFromStoredConversation({
      access,
      automationTitle: automationTitles.get(conversationId),
      conversation,
      durationMs: 0,
      firstHumanMessageText: firstTexts.get(conversationId),
    }),
    url: canonicalUrl,
  });
}
