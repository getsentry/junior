import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { briefRepositories } from "@/chat/spaces/classify";
import {
  listSpaceConversations,
  readSpaceTree,
  resolveSpaceId,
  type SpaceConversation,
} from "@/chat/spaces/store";
import { subtreeSpaceIds } from "@/chat/spaces/tree";
import type { ConversationKind, SpaceNode } from "@/chat/spaces/types";
import { readConversationFeedFromSql } from "../conversations/list";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import type {
  ActorIdentity,
  ConversationSummaryReport,
} from "../schema/conversation";
import {
  spaceDetailReportSchema,
  spaceParamsSchema,
  spaceTreeReportSchema,
  type SpaceFacts,
  type SpaceSummary,
} from "../schema/space";
import { validateRequest } from "../validation";

const SPACE_CONVERSATION_LIMIT = 100;
const MAX_FACT_REPOSITORIES = 6;
const MAX_FACT_CHANNELS = 8;
const MAX_FACT_PARTICIPANTS = 12;

function countBy<T>(items: Iterable<T>): Array<[T, number]> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function participantKey(participant: ActorIdentity): string | undefined {
  return (
    participant.email?.trim().toLowerCase() ||
    participant.slackUserId?.trim() ||
    participant.fullName?.trim() ||
    undefined
  );
}

/**
 * Collect hard facts about a Space from its listed public Conversations,
 * newest first: repositories, channels, people, and kinds.
 */
function spaceFacts(
  listed: readonly SpaceConversation[],
  summaries: ReadonlyMap<string, ConversationSummaryReport>,
): SpaceFacts {
  const people = new Map<string, { identity: ActorIdentity; count: number }>();
  for (const conversation of listed) {
    for (const participant of summaries.get(conversation.conversationId)
      ?.participants ?? []) {
      const key = participantKey(participant);
      if (!key) continue;
      const entry = people.get(key);
      if (entry) entry.count += 1;
      else people.set(key, { identity: participant, count: 1 });
    }
  }
  return {
    repositories: countBy(
      listed.flatMap((conversation) => briefRepositories(conversation.links)),
    )
      .slice(0, MAX_FACT_REPOSITORIES)
      .map(([name, conversationCount]) => ({
        name,
        url: `https://github.com/${name}`,
        conversationCount,
      })),
    channels: countBy(
      listed.flatMap((conversation) =>
        conversation.channelName ? [conversation.channelName] : [],
      ),
    )
      .slice(0, MAX_FACT_CHANNELS)
      .map(([name, conversationCount]) => ({ name, conversationCount })),
    participants: [...people.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, MAX_FACT_PARTICIPANTS)
      .map((entry) => entry.identity),
    kinds: countBy(
      listed.flatMap((conversation): ConversationKind[] =>
        conversation.kind ? [conversation.kind] : [],
      ),
    ).map(([kind, conversationCount]) => ({ kind, conversationCount })),
  };
}

function spaceSummary(node: SpaceNode): SpaceSummary {
  return {
    spaceId: node.spaceId,
    parentSpaceId: node.parentSpaceId ?? null,
    name: node.name,
    description: node.description,
    path: node.path,
    childCount: node.childSpaceIds.length,
    conversationCount: node.conversationCount,
    totalConversationCount: node.totalConversationCount,
    lastActivityAt:
      node.lastActivityAtMs !== undefined
        ? new Date(node.lastActivityAtMs).toISOString()
        : null,
  };
}

/** Create the read-only Space API. Private Conversations are only counted. */
export function createSpaceRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", async () => {
    const tree = await readSpaceTree(getDb());
    return jsonResponse(spaceTreeReportSchema, {
      spaces: [...tree.values()].map(spaceSummary),
    });
  });
  app.get(
    "/:spaceId",
    validateRequest("param", spaceParamsSchema, "Invalid route parameters."),
    async (context) => {
      const db = getDb();
      const { spaceId: requestedId } = context.req.valid("param");
      const spaceId = await resolveSpaceId(db, requestedId);
      if (!spaceId) throwApiError(404, "Space not found.");
      const tree = await readSpaceTree(db);
      const space = tree.get(spaceId);
      if (!space) throwApiError(404, "Space not found.");
      const breadcrumbs: Array<{ spaceId: string; name: string }> = [];
      for (
        let parent = space.parentSpaceId
          ? tree.get(space.parentSpaceId)
          : undefined;
        parent;
        parent = parent.parentSpaceId
          ? tree.get(parent.parentSpaceId)
          : undefined
      ) {
        breadcrumbs.unshift({ spaceId: parent.spaceId, name: parent.name });
      }
      const listed = await listSpaceConversations(db, {
        spaceIds: subtreeSpaceIds(tree, spaceId),
        limit: SPACE_CONVERSATION_LIMIT,
      });
      const viewer = context.get("viewer");
      const feed = await readConversationFeedFromSql({
        conversationIds: listed.conversations.map(
          (conversation) => conversation.conversationId,
        ),
        limit: SPACE_CONVERSATION_LIMIT,
        ...(viewer ? { viewer } : undefined),
      });
      const summaries = new Map(
        feed.conversations.map((summary) => [summary.conversationId, summary]),
      );
      return jsonResponse(spaceDetailReportSchema, {
        space: spaceSummary(space),
        breadcrumbs,
        children: space.childSpaceIds.map((childId) =>
          spaceSummary(tree.get(childId)!),
        ),
        facts: spaceFacts(listed.conversations, summaries),
        conversations: listed.conversations.flatMap((conversation) => {
          const summary = summaries.get(conversation.conversationId);
          return summary
            ? [
                {
                  ...summary,
                  spaceId: conversation.spaceId,
                  summary: conversation.summary ?? null,
                  kind: conversation.kind ?? null,
                },
              ]
            : [];
        }),
        privateConversationCount: listed.privateCount,
      });
    },
  );
  return app;
}
