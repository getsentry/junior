import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  leadSchema,
  spaceParamsSchema,
  type ActorIdentity,
  type ConversationReportEvent,
} from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import { NOW_MS } from "./fixtures";
import { mockLeadEvents } from "./lead-transcript";
import { createMockLead, findMockLead } from "./sends";
import { AVERY, MOCK_SPACE_IDS, RILEY, readMockSpace } from "./spaces";

const identity = (member: { displayName: string; email: string }) => ({
  email: member.email,
  fullName: member.displayName,
});

/**
 * The first events of a seeded Space's Lead. Billing migration has the
 * fixture transcript, which Avery and the viewer both talk in. Docs
 * refresh, which the viewer is not in, has one exchange with Riley. A Space
 * without seeds starts empty.
 */
function seededLeadEvents(
  spaceId: string,
  viewer: ActorIdentity,
): ConversationReportEvent[] | undefined {
  if (spaceId === MOCK_SPACE_IDS.billing) {
    return mockLeadEvents(viewer, identity(AVERY));
  }
  if (spaceId !== MOCK_SPACE_IDS.docs) return undefined;
  const at = (minutes: number) =>
    new Date(NOW_MS - minutes * 60_000).toISOString();
  const turnId = "mock-docs-lead-outline";
  return [
    {
      createdAt: at(90),
      data: {
        type: "message",
        messageId: `${turnId}-request`,
        role: "user",
        source: "web",
        actorIdentity: identity(RILEY),
        text: "Which onboarding pages still describe the old setup flow?",
      },
      seq: 0,
    },
    {
      createdAt: at(90),
      data: {
        type: "turn_lifecycle",
        turnId,
        state: "started",
        inputMessageIds: [`${turnId}-request`],
      },
      seq: 1,
    },
    {
      createdAt: at(89),
      data: {
        type: "message",
        messageId: `${turnId}-reply`,
        role: "assistant",
        text: "Three: Quick start, Install the SDK, and Verify your setup. Tell me if you want a conversation started to rewrite them.",
      },
      seq: 2,
    },
    {
      createdAt: at(89),
      data: { type: "turn_lifecycle", turnId, state: "succeeded" },
      seq: 3,
    },
  ];
}

/**
 * Create the mock `GET /spaces/:spaceId/lead`, as the API has it. A
 * member's read makes the Lead. A non-member reads it only once it exists.
 * The seeded Spaces other than Mobile app have a Lead from the start.
 */
export function createMockSpaceLeadRoutes(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.get("/:spaceId/lead", (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return errorResponse("Authentication required.", 401);
    const params = spaceParamsSchema.safeParse(c.req.param());
    if (!params.success) return errorResponse("Invalid route parameters.", 400);
    const space = readMockSpace(params.data.spaceId);
    if (!space) return errorResponse("Space was not found.", 404);
    const actorIdentity = {
      email: viewer.email,
      fullName: viewer.displayName ?? viewer.email,
    };
    const seeded = seededLeadEvents(space.id, actorIdentity);
    if (!findMockLead(space.id) && !space.viewerMember && !seeded) {
      return errorResponse("This Space has no Lead yet.", 404);
    }
    const conversationId = createMockLead({
      actorIdentity,
      events: seeded ?? [],
      spaceId: space.id,
      title: space.name,
    });
    return jsonResponse(
      leadSchema,
      { conversationId },
      { headers: { "cache-control": "private, no-store" } },
    );
  });
  return app;
}
