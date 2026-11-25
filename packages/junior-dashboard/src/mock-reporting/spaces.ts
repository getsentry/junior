import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  archiveSpaceBodySchema,
  conversationParamsSchema,
  createSpaceBodySchema,
  setConversationSpaceBodySchema,
  setConversationSpaceResponseSchema,
  spaceListQuerySchema,
  spaceListSchema,
  spaceMemberListSchema,
  spaceParamsSchema,
  spaceSchema,
  type ConversationDetailReport,
  type ConversationFeed,
  type SpaceRefReport,
  type SpaceReport,
} from "@sentry/junior/api/schema";
import type { User } from "@sentry/junior-plugin-api";
import { errorResponse } from "./errors";
import {
  NOW_MS,
  readMockConversationDetail,
  setMockConversationArchived,
} from "./fixtures";

type MockMember = {
  avatarUrl: string | null;
  displayName: string;
  email: string;
};

type MockSpace = {
  /** Conversations that the Space's archive archived, for its restore. */
  archived: string[];
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
  /** Members other than the viewer. */
  others: MockMember[];
  viewerMember: boolean;
};

const AVERY: MockMember = {
  avatarUrl: null,
  displayName: "Avery Chen",
  email: "avery@sentry.io",
};
const RILEY: MockMember = {
  avatarUrl: null,
  displayName: "Riley Park",
  email: "riley@sentry.io",
};

/** The seeded Spaces. The viewer is a member of the first two. */
const MOCK_SPACE_IDS = {
  billing: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21",
  docs: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a23",
  ios: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a22",
} as const;

function seedSpaces(): MockSpace[] {
  const at = (daysAgo: number) =>
    new Date(NOW_MS - daysAgo * 86_400_000).toISOString();
  return [
    {
      archived: [],
      archivedAt: null,
      createdAt: at(30),
      description:
        "Move invoicing to the new billing provider without double charges.",
      id: MOCK_SPACE_IDS.billing,
      name: "Billing migration",
      others: [AVERY],
      viewerMember: true,
    },
    {
      archived: [],
      archivedAt: null,
      createdAt: at(20),
      description: null,
      id: MOCK_SPACE_IDS.ios,
      name: "Mobile app",
      others: [AVERY, RILEY],
      viewerMember: true,
    },
    {
      archived: [],
      archivedAt: null,
      createdAt: at(10),
      description: "Refresh the onboarding docs for the new setup flow.",
      id: MOCK_SPACE_IDS.docs,
      name: "Docs refresh",
      others: [RILEY],
      viewerMember: false,
    },
  ];
}

const SEEDED_CONVERSATION_SPACES = [
  ["internal:questions-qa", MOCK_SPACE_IDS.billing],
  ["internal:history-6", MOCK_SPACE_IDS.billing],
  ["internal:history-8", MOCK_SPACE_IDS.ios],
  ["internal:history-4", MOCK_SPACE_IDS.docs],
] as const;

const mockSpaces = new Map<string, MockSpace>();
/** The Space of each root, by Conversation id. */
const mockConversationSpaces = new Map<string, string>();

/** Put the mock Spaces back to their seeds between tests. */
export function resetMockSpaces(): void {
  mockSpaces.clear();
  for (const space of seedSpaces()) mockSpaces.set(space.id, space);
  mockConversationSpaces.clear();
  for (const [conversationId, spaceId] of SEEDED_CONVERSATION_SPACES) {
    mockConversationSpaces.set(conversationId, spaceId);
  }
}

resetMockSpaces();

function spaceRef(spaceId: string | undefined): SpaceRefReport | null {
  const space = spaceId ? mockSpaces.get(spaceId) : undefined;
  return space ? { id: space.id, name: space.name } : null;
}

/** Label each feed row with its Space, as the API does. */
export function withMockSpaces(feed: ConversationFeed): ConversationFeed {
  return {
    ...feed,
    conversations: feed.conversations.map((row) => ({
      ...row,
      space: spaceRef(mockConversationSpaces.get(row.conversationId)),
    })),
  };
}

/** Keep the feed rows of one Space. */
export function filterMockConversationsBySpace(
  feed: ConversationFeed,
  spaceId: string,
): ConversationFeed {
  return {
    ...feed,
    conversations: feed.conversations.filter(
      (row) => mockConversationSpaces.get(row.conversationId) === spaceId,
    ),
  };
}

/** Label a detail with the Space of its root. A child is in its root's. */
export function withMockSpace<T extends ConversationDetailReport>(
  detail: T,
): T {
  const rootId = detail.agentTree?.[0]?.conversationId ?? detail.conversationId;
  return { ...detail, space: spaceRef(mockConversationSpaces.get(rootId)) };
}

/**
 * Check that the viewer can add work to a Space, as the API does: it must
 * exist, be active, and have the viewer as a member.
 */
export function mockSpaceForWork(
  spaceId: string,
): { space: MockSpace } | { error: string; status: 403 | 404 | 409 } {
  const space = mockSpaces.get(spaceId);
  if (!space) return { error: "Space was not found.", status: 404 };
  if (space.archivedAt)
    return {
      error: "Restore the Space before you add work to it.",
      status: 409,
    };
  if (!space.viewerMember)
    return { error: "Join the Space to add work to it.", status: 403 };
  return { space };
}

/** Put a new root in a Space. */
export function startMockConversationInSpace(
  conversationId: string,
  spaceId: string,
): void {
  mockConversationSpaces.set(conversationId, spaceId);
}

/**
 * Add `PUT /conversations/:conversationId/space`, which moves a root into a
 * Space, or into none with null, with the API's rules.
 */
export function addMockConversationSpaceRoute(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.put("/conversations/:conversationId/space", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const body = setConversationSpaceBodySchema.safeParse(await c.req.json());
    if (!params.success || !body.success)
      return errorResponse("Invalid request.", 400);
    const { conversationId } = params.data;
    const conversation = readMockConversationDetail(conversationId, 1);
    if (!conversation?.isParticipant)
      return errorResponse("Conversation not found.", 404);
    if (conversation.kind !== "root" && conversation.kind !== "automation")
      return errorResponse(
        "Only a top-level conversation moves. A child is in the Space of its root.",
        409,
      );
    const { spaceId } = body.data;
    if (spaceId) {
      const target = mockSpaceForWork(spaceId);
      if ("error" in target) return errorResponse(target.error, target.status);
      if (conversation.visibility === "private")
        return errorResponse(
          "Only a public conversation can join a Space.",
          409,
        );
      mockConversationSpaces.set(conversationId, spaceId);
    } else {
      mockConversationSpaces.delete(conversationId);
    }
    return jsonResponse(setConversationSpaceResponseSchema, {
      space: spaceRef(spaceId ?? undefined),
    });
  });
}

function view(space: MockSpace): SpaceReport {
  return {
    archivedAt: space.archivedAt,
    createdAt: space.createdAt,
    description: space.description,
    id: space.id,
    memberCount: space.others.length + (space.viewerMember ? 1 : 0),
    name: space.name,
    updatedAt: space.archivedAt ?? space.createdAt,
    viewerIsMember: space.viewerMember,
  };
}

function members(space: MockSpace, viewer: User) {
  const others = space.others.map((member) => ({
    ...member,
    joinedAt: space.createdAt,
    userId: `mock-user:${member.email}`,
  }));
  return space.viewerMember
    ? [
        {
          avatarUrl: null,
          displayName: viewer.displayName ?? null,
          email: viewer.email,
          joinedAt: space.createdAt,
          userId: viewer.id,
        },
        ...others,
      ]
    : others;
}

/** Archive or restore a mock Space with its Conversations, as the API does. */
function setArchived(space: MockSpace, archived: boolean): void {
  if (archived === Boolean(space.archivedAt)) return;
  if (archived) {
    space.archivedAt = new Date().toISOString();
    space.archived = [...mockConversationSpaces]
      .filter(([, spaceId]) => spaceId === space.id)
      .flatMap(([conversationId]) =>
        setMockConversationArchived(conversationId, true, true)
          ? [conversationId]
          : [],
      );
    return;
  }
  space.archivedAt = null;
  for (const conversationId of space.archived) {
    setMockConversationArchived(conversationId, false, true);
  }
  space.archived = [];
}

/** Find the Space of a route, or the API's error for it. */
function findSpace(param: Record<string, string>): MockSpace | Response {
  const params = spaceParamsSchema.safeParse(param);
  if (!params.success) return errorResponse("Invalid route parameters.", 400);
  return (
    mockSpaces.get(params.data.spaceId) ??
    errorResponse("Space was not found.", 404)
  );
}

/** Create the mock `/api/spaces` routes. Every Space is public. */
export function createMockSpaceRoutes(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    if (!c.get("viewer")) return errorResponse("Authentication required.", 401);
    return next();
  });
  app.get("/", (c) => {
    const query = spaceListQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse("Invalid query parameters.", 400);
    const spaces = [...mockSpaces.values()]
      .filter(
        (space) =>
          (query.data.membership === "all" || space.viewerMember) &&
          Boolean(space.archivedAt) === query.data.archived,
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    return jsonResponse(spaceListSchema, { spaces: spaces.map(view) });
  });
  app.post("/", async (c) => {
    const body = createSpaceBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    const space: MockSpace = {
      archived: [],
      archivedAt: null,
      createdAt: new Date().toISOString(),
      description: body.data.description ?? null,
      id: crypto.randomUUID(),
      name: body.data.name,
      others: [],
      viewerMember: true,
    };
    mockSpaces.set(space.id, space);
    return jsonResponse(spaceSchema, view(space), { status: 201 });
  });
  app.get("/:spaceId", (c) => {
    const space = findSpace(c.req.param());
    return space instanceof Response
      ? space
      : jsonResponse(spaceSchema, view(space));
  });
  app.get("/:spaceId/members", (c) => {
    const space = findSpace(c.req.param());
    return space instanceof Response
      ? space
      : jsonResponse(spaceMemberListSchema, {
          members: members(space, c.get("viewer")!),
        });
  });
  // An archived Space can be joined too, as in the API.
  for (const [method, join] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app[method]("/:spaceId/members/me", (c) => {
      const space = findSpace(c.req.param());
      if (space instanceof Response) return space;
      space.viewerMember = join;
      return jsonResponse(spaceSchema, view(space));
    });
  }
  app.patch("/:spaceId/archive", async (c) => {
    const space = findSpace(c.req.param());
    if (space instanceof Response) return space;
    if (!space.viewerMember)
      return errorResponse("Join the Space to change it.", 403);
    const body = archiveSpaceBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    setArchived(space, body.data.archived);
    return jsonResponse(spaceSchema, view(space));
  });
  return app;
}
