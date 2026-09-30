import { Hono } from "hono";
import { getDb } from "@/chat/db";
import {
  listSpaceConversations,
  readSpaceTree,
  resolveSpaceId,
} from "@/chat/spaces/store";
import { subtreeSpaceIds } from "@/chat/spaces/tree";
import type { SpaceNode } from "@/chat/spaces/types";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  spaceDetailReportSchema,
  spaceParamsSchema,
  spaceTreeReportSchema,
  type SpaceSummary,
} from "../schema/space";
import { validateRequest } from "../validation";

const SPACE_CONVERSATION_LIMIT = 100;

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
      return jsonResponse(spaceDetailReportSchema, {
        space: spaceSummary(space),
        breadcrumbs,
        children: space.childSpaceIds.map((childId) =>
          spaceSummary(tree.get(childId)!),
        ),
        conversations: listed.conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          spaceId: conversation.spaceId,
          title: conversation.title ?? null,
          channelName: conversation.channelName ?? null,
          summary: conversation.summary ?? null,
          lastActivityAt: new Date(conversation.lastActivityAtMs).toISOString(),
        })),
        privateConversationCount: listed.privateCount,
      });
    },
  );
  return app;
}
