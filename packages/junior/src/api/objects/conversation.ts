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

async function readViewerAccess(viewer: User, conversationId: string) {
  return (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
}

/**
 * Return whether the viewer sees the private content of the linked
 * Conversation: a public Conversation, or a private one that they take part
 * in. A link to no Conversation returns false.
 */
export async function canViewConversationLink(
  viewer: User,
  url: URL,
): Promise<boolean> {
  const conversationId = parseDashboardConversationLink(url.href);
  if (!conversationId) return false;
  return (
    (await readViewerAccess(viewer, conversationId))?.canViewPrivateContent ??
    false
  );
}

/**
 * Resolve a dashboard Conversation link for a viewer that
 * `canViewConversationLink` allows. A link to no Conversation returns
 * nothing.
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
  // The card shows what this access allows, so it is read again here.
  const access = await readViewerAccess(viewer, conversationId);
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
