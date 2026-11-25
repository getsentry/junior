import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  addSpaceMemberBodySchema,
  archiveSpaceBodySchema,
  conversationParamsSchema,
  createSpaceBodySchema,
  setConversationSpaceBodySchema,
  setConversationSpaceResponseSchema,
  spaceConfigurationSchema,
  spaceListQuerySchema,
  spaceListSchema,
  spaceMemberListSchema,
  spaceParamsSchema,
  spaceSchema,
  updateSpaceBodySchema,
  type ConversationDetailReport,
  type ConversationFeed,
  type SpaceConfigurationReport,
  type SpaceRefReport,
  type SpaceReport,
  type SpaceVisibilityReport,
} from "@sentry/junior/api/schema";
import type { User } from "@sentry/junior-plugin-api";
import { errorResponse } from "./errors";
import {
  NOW_MS,
  readMockConversationDetail,
  setMockConversationArchived,
} from "./fixtures";
import { mockLeadSpaceId } from "./sends";

type SpaceConfigEntry = SpaceConfigurationReport["entries"][number];

type MockMember = {
  avatarUrl: string | null;
  displayName: string;
  email: string;
};

type MockSpace = {
  /** Conversations that the Space's archive archived, for its restore. */
  archived: string[];
  archivedAt: string | null;
  /** Configuration values by key. */
  configuration: Map<string, Omit<SpaceConfigEntry, "key">>;
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
  /** Members other than the viewer. */
  others: MockMember[];
  viewerMember: boolean;
  visibility: SpaceVisibilityReport;
};

/** A member of every seeded Space but Docs refresh. */
export const AVERY: MockMember = {
  avatarUrl: null,
  displayName: "Avery Chen",
  email: "avery@sentry.io",
};
/** A member of Mobile app and Docs refresh. */
export const RILEY: MockMember = {
  avatarUrl: null,
  displayName: "Riley Park",
  email: "riley@sentry.io",
};

/** A person who is in no seeded Space, whom a member can add. */
const CASEY: MockMember = {
  avatarUrl: null,
  displayName: "Casey Nguyen",
  email: "casey@example.com",
};

/** The people whom a member can add by email, other than the viewer. */
const MOCK_PEOPLE = [AVERY, RILEY, CASEY];

/**
 * The seeded Spaces. The viewer is a member of all but Docs refresh. Pricing
 * launch is private.
 */
export const MOCK_SPACE_IDS = {
  billing: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21",
  docs: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a23",
  ios: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a22",
  pricing: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a24",
} as const;

function seedSpaces(): MockSpace[] {
  const at = (daysAgo: number) =>
    new Date(NOW_MS - daysAgo * 86_400_000).toISOString();
  return [
    {
      archived: [],
      archivedAt: null,
      configuration: new Map([
        ["github.repo", { updatedAt: at(2), value: "getsentry/junior" }],
      ]),
      createdAt: at(30),
      description:
        "Move invoicing to the new billing provider without double charges.",
      id: MOCK_SPACE_IDS.billing,
      name: "Billing migration",
      others: [AVERY],
      viewerMember: true,
      visibility: "public",
    },
    {
      archived: [],
      archivedAt: null,
      configuration: new Map(),
      createdAt: at(20),
      description: null,
      id: MOCK_SPACE_IDS.ios,
      name: "Mobile app",
      others: [AVERY, RILEY],
      viewerMember: true,
      visibility: "public",
    },
    {
      archived: [],
      archivedAt: null,
      configuration: new Map(),
      createdAt: at(10),
      description: "Refresh the onboarding docs for the new setup flow.",
      id: MOCK_SPACE_IDS.docs,
      name: "Docs refresh",
      others: [RILEY],
      viewerMember: false,
      visibility: "public",
    },
    {
      archived: [],
      archivedAt: null,
      configuration: new Map(),
      createdAt: at(5),
      description: "Plan the new pricing tiers before the announcement.",
      id: MOCK_SPACE_IDS.pricing,
      name: "Pricing launch",
      others: [AVERY],
      viewerMember: true,
      visibility: "private",
    },
  ];
}

const SEEDED_CONVERSATION_SPACES = [
  ["internal:questions-qa", MOCK_SPACE_IDS.billing],
  ["internal:history-6", MOCK_SPACE_IDS.billing],
  ["internal:history-8", MOCK_SPACE_IDS.ios],
  ["internal:history-4", MOCK_SPACE_IDS.docs],
] as const;

// Only a public Conversation can join a Space, so the seeded ones are public.
const SEEDED_PUBLIC_IDS = new Set<string>(
  SEEDED_CONVERSATION_SPACES.map(([conversationId]) => conversationId),
);

const mockSpaces = new Map<string, MockSpace>();
/** The Space of each root, by Conversation id. */
const mockConversationSpaces = new Map<string, string>();

/** A root in a private Space is private, as the API makes it. */
function visibilityOf(
  conversationId: string,
  visibility: "private" | "public" | undefined,
) {
  const spaceId = mockConversationSpaces.get(conversationId);
  if (spaceId && mockSpaces.get(spaceId)?.visibility === "private")
    return "private";
  return SEEDED_PUBLIC_IDS.has(conversationId) ? "public" : visibility;
}

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
  const space = spaceId ? readMockSpace(spaceId) : undefined;
  return space ? { id: space.id, name: space.name } : null;
}

/** Label each feed row with its Space, as the API does. */
export function withMockSpaces(feed: ConversationFeed): ConversationFeed {
  return {
    ...feed,
    conversations: feed.conversations.map((row) => ({
      ...row,
      space: spaceRef(mockConversationSpaces.get(row.conversationId)),
      visibility: visibilityOf(row.conversationId, row.visibility),
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

/**
 * Label a detail with the Space of its root. A child is in its root's, and
 * a Lead is in its own.
 */
export function withMockSpace<T extends ConversationDetailReport>(
  detail: T,
): T {
  const rootId = detail.agentTree?.[0]?.conversationId ?? detail.conversationId;
  return {
    ...detail,
    space: spaceRef(
      mockConversationSpaces.get(rootId) ?? mockLeadSpaceId(rootId),
    ),
    visibility: visibilityOf(detail.conversationId, detail.visibility),
  };
}

/**
 * Read one mock Space, as the routes see it. A private Space is missing to
 * a person who is not a member, as in the API.
 */
export function readMockSpace(spaceId: string): MockSpace | undefined {
  const space = mockSpaces.get(spaceId);
  return space && readable(space) ? space : undefined;
}

function readable(space: MockSpace): boolean {
  return space.visibility === "public" || space.viewerMember;
}

/**
 * Check that the viewer can add work to a Space, as the API does: it must
 * exist, be active, and have the viewer as a member.
 */
export function mockSpaceForWork(
  spaceId: string,
): { space: MockSpace } | { error: string; status: 403 | 404 | 409 } {
  const space = readMockSpace(spaceId);
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
    const from = mockConversationSpaces.get(conversationId);
    if (from && mockSpaces.get(from)?.visibility === "private")
      return errorResponse(
        "A conversation in a private Space stays in it.",
        409,
      );
    if (spaceId) {
      const target = mockSpaceForWork(spaceId);
      if ("error" in target) return errorResponse(target.error, target.status);
      if (visibilityOf(conversationId, conversation.visibility) !== "public")
        return errorResponse(
          "Only a public conversation can join a Space.",
          409,
        );
      if (target.space.visibility === "private")
        return errorResponse(
          "A conversation can't join a private Space. Start it in the Space.",
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
    visibility: space.visibility,
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

/**
 * Archive or restore a mock Space with its Conversations, as the API does.
 * The archive skips a root that is already archived, so the restore leaves
 * it archived.
 */
function setArchived(space: MockSpace, archived: boolean): void {
  if (archived === Boolean(space.archivedAt)) return;
  if (archived) {
    space.archivedAt = new Date().toISOString();
    space.archived = [...mockConversationSpaces]
      .filter(
        ([conversationId, spaceId]) =>
          spaceId === space.id &&
          !readMockConversationDetail(conversationId, 1)?.archivedAt,
      )
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

function configurationResponse(space: MockSpace): Response {
  return jsonResponse(spaceConfigurationSchema, {
    entries: [...space.configuration]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => ({ key, ...entry })),
  });
}

/** Find the Space of a route, or the API's error for it. */
function findSpace(param: Record<string, string>): MockSpace | Response {
  const params = spaceParamsSchema.safeParse(param);
  if (!params.success) return errorResponse("Invalid route parameters.", 400);
  return (
    readMockSpace(params.data.spaceId) ??
    errorResponse("Space was not found.", 404)
  );
}

/**
 * Create the mock `/api/spaces` routes. A private Space is missing to a
 * person who is not a member.
 */
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
          readable(space) &&
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
      configuration: new Map(),
      createdAt: new Date().toISOString(),
      description: body.data.description ?? null,
      id: crypto.randomUUID(),
      name: body.data.name,
      others: [],
      viewerMember: true,
      visibility: body.data.visibility,
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
  app.patch("/:spaceId", async (c) => {
    const space = findSpace(c.req.param());
    if (space instanceof Response) return space;
    if (!space.viewerMember)
      return errorResponse("Join the Space to change it.", 403);
    const body = updateSpaceBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    const { description, name, visibility } = body.data;
    if (visibility !== undefined)
      return errorResponse(
        "A Space's visibility is set when it is created. Create a new Space for a different audience.",
        400,
      );
    if (name !== undefined) space.name = name;
    if (description !== undefined) space.description = description;
    return jsonResponse(spaceSchema, view(space));
  });
  // A person cannot find a private Space to join it, so a member adds them.
  app.post("/:spaceId/members", async (c) => {
    const space = findSpace(c.req.param());
    if (space instanceof Response) return space;
    if (!space.viewerMember)
      return errorResponse("Join the Space to change it.", 403);
    const body = addSpaceMemberBodySchema.safeParse(await c.req.json());
    if (!body.success) return errorResponse("Invalid request body.", 400);
    const email = body.data.email.toLowerCase();
    const viewer = c.get("viewer")!;
    const person = MOCK_PEOPLE.find((member) => member.email === email);
    if (!person && email !== viewer.email.toLowerCase())
      return errorResponse("No person has that email.", 404);
    if (person && !space.others.includes(person)) space.others.push(person);
    return jsonResponse(spaceSchema, view(space));
  });
  // An archived Space can be joined too, as in the API.
  app.put("/:spaceId/members/me", (c) => {
    const space = findSpace(c.req.param());
    if (space instanceof Response) return space;
    space.viewerMember = true;
    return jsonResponse(spaceSchema, view(space));
  });
  app.delete("/:spaceId/members/me", (c) => {
    const space = findSpace(c.req.param());
    if (space instanceof Response) return space;
    // Nobody could read a private Space with no members.
    if (
      space.visibility === "private" &&
      space.viewerMember &&
      space.others.length === 0
    )
      return errorResponse("The last member can't leave a private Space.", 409);
    space.viewerMember = false;
    return jsonResponse(spaceSchema, view(space));
  });
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
  app.get("/:spaceId/configuration", (c) => {
    const space = findSpace({ spaceId: c.req.param("spaceId") });
    return space instanceof Response ? space : configurationResponse(space);
  });
  return app;
}
