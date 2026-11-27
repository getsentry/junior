import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  archiveSpaceBodySchema,
  conversationLeaveResponseSchema,
  conversationSubscriptionBodySchema,
  conversationSubscriptionResponseSchema,
  conversationParamsSchema,
  createSpaceBodySchema,
  setConversationSpaceBodySchema,
  setConversationSpaceResponseSchema,
  spaceListQuerySchema,
  spaceListSchema,
  spaceParamsSchema,
  spaceSchema,
  updateSpaceBodySchema,
  type ActorIdentity,
  type ConversationDetailReport,
  type ConversationFeed,
  type ConversationReportEvent,
  type SpaceRefReport,
  type SpaceReport,
  type SpaceVisibilityReport,
} from "@sentry/junior/api/schema";
import type { User } from "@sentry/junior-plugin-api";
import { errorResponse } from "./errors";
import {
  NOW_MS,
  readMockConversationDetail,
  readMockConversationFeed,
  setMockConversationArchived,
} from "./fixtures";
import { mockLeadEvents } from "./lead-transcript";
import { createMockLead, mockLeadId, mockLeadSpaceId } from "./sends";

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
  /**
   * Like the API, a Leave of a public Lead keeps the viewer's Participant
   * row. Only a private Leave drops it.
   */
  viewerParticipant: boolean;
  visibility: SpaceVisibilityReport;
};

/** A member of every seeded Space but Docs refresh. */
const AVERY: MockMember = {
  avatarUrl: null,
  displayName: "Avery Chen",
  email: "avery@sentry.io",
};
/** A member of Mobile app and Docs refresh. */
const RILEY: MockMember = {
  avatarUrl: null,
  displayName: "Riley Park",
  email: "riley@sentry.io",
};

/**
 * The seeded Spaces. The viewer is a member of all but Docs refresh. Pricing
 * launch is private.
 */
const MOCK_SPACE_IDS = {
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
      createdAt: at(30),
      description:
        "Move invoicing to the new billing provider without double charges.",
      id: MOCK_SPACE_IDS.billing,
      name: "Billing migration",
      others: [AVERY],
      viewerMember: true,

      viewerParticipant: true,
      visibility: "public",
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

      viewerParticipant: true,
      visibility: "public",
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

      viewerParticipant: false,
      visibility: "public",
    },
    {
      archived: [],
      archivedAt: null,
      createdAt: at(5),
      description: "Plan the new pricing tiers before the announcement.",
      id: MOCK_SPACE_IDS.pricing,
      name: "Pricing launch",
      others: [AVERY],
      viewerMember: true,

      viewerParticipant: true,
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

/**
 * Label each feed row with its Space, as the API does. A row in a Space is
 * a child of its Lead there.
 */
export function withMockSpaces(feed: ConversationFeed): ConversationFeed {
  return {
    ...feed,
    conversations: feed.conversations.map((row) => {
      const spaceId = mockConversationSpaces.get(row.conversationId);
      return {
        ...row,
        ...(spaceId
          ? { parentConversationId: mockLeadId(spaceId) }
          : undefined),
        space: spaceRef(spaceId),
        visibility: visibilityOf(row.conversationId, row.visibility),
      };
    }),
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

/** A mock row's tree state. A row with none reads one from its own status. */
export function mockTreeState(row: ConversationFeed["conversations"][number]) {
  return (
    row.treeState ??
    (row.status === "needs_input"
      ? "needs_you"
      : row.turnActive || row.status === "working"
        ? "working"
        : "done")
  );
}

/**
 * Label a detail with the Space of its root. A child is in its root's, and
 * a Lead is in its own.
 */
export function withMockSpace<T extends ConversationDetailReport>(
  detail: T,
): T {
  const rootId = detail.agentTree?.[0]?.conversationId ?? detail.conversationId;
  const leadSpaceId = mockLeadSpaceId(detail.conversationId);
  const leadSpace = leadSpaceId ? readMockSpace(leadSpaceId) : undefined;
  const rootSpace = mockSpaces.get(mockLeadSpaceId(rootId) ?? "");
  return {
    ...detail,
    // A Lead has its Space's name, and a Space archive archives it.
    ...(leadSpace
      ? { archivedAt: leadSpace.archivedAt, displayTitle: leadSpace.name }
      : undefined),
    space: spaceRef(
      mockConversationSpaces.get(rootId) ?? mockLeadSpaceId(rootId),
    ),
    visibility: visibilityOf(detail.conversationId, detail.visibility),
    ...(rootSpace ? leadParticipation(rootSpace, detail) : undefined),
  };
}

/**
 * The Participants of a mock Lead: its Space's members, as in the API. Its
 * first Actor is the viewer, a member while they have not left.
 */
function leadParticipation(
  space: MockSpace,
  detail: ConversationDetailReport,
): Partial<ConversationDetailReport> {
  const member = space.viewerMember;
  const participants: ActorIdentity[] = [
    ...(member && detail.actorIdentity ? [detail.actorIdentity] : []),
    ...space.others.map((other) => ({
      email: other.email,
      fullName: other.displayName,
    })),
  ];
  return {
    // Match the API: only a Participant may Invite. Set the key either way,
    // so it replaces the Lead fixture's own canInvite.
    canInvite: space.viewerParticipant ? true : undefined,
    isParticipant: space.viewerParticipant,
    participants,
    subscribed: member,
    visibility: space.visibility,
    ...(space.visibility === "private" && member
      ? { leaveEndsAccess: true as const }
      : undefined),
  };
}

/**
 * Add a person to a mock Lead's Participants, the members of its Space.
 * Returns undefined for a Conversation that is not a Lead.
 */
export function addMockLeadParticipant(
  conversationId: string,
  person: { email: string; fullName: string },
): { added: boolean } | undefined {
  const space = mockSpaces.get(mockLeadSpaceId(conversationId) ?? "");
  if (!space) return undefined;
  if (space.others.some((other) => other.email === person.email)) {
    return { added: false };
  }
  space.others.push({
    avatarUrl: null,
    displayName: person.fullName,
    email: person.email,
  });
  return { added: true };
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
 * Space, or into none with null, with the API's rules, and Leave and
 * Subscribe of a Lead, which change its Space's membership.
 */
export function addMockConversationSpaceRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.post("/conversations/:conversationId/leave", (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) return errorResponse("Invalid route parameters.", 400);
    const space = mockSpaces.get(
      mockLeadSpaceId(params.data.conversationId) ?? "",
    );
    if (!space?.viewerMember)
      return errorResponse("Conversation not found.", 404);
    space.viewerMember = false;
    if (space.visibility === "private") space.viewerParticipant = false;
    return jsonResponse(conversationLeaveResponseSchema, { archivedAt: null });
  });
  app.patch("/conversations/:conversationId/subscription", async (c, next) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const space = params.success
      ? mockSpaces.get(mockLeadSpaceId(params.data.conversationId) ?? "")
      : undefined;
    if (!space) return next();
    const body = conversationSubscriptionBodySchema.safeParse(
      await c.req.json(),
    );
    if (!body.success) return errorResponse("Invalid request body.", 400);
    // Match the API: only a public Lead takes a Join from a non-Participant.
    if (!space.viewerParticipant && space.visibility === "private")
      return errorResponse("Conversation not found.", 404);
    space.viewerMember = body.data.subscribed;
    if (body.data.subscribed) space.viewerParticipant = true;
    return jsonResponse(conversationSubscriptionResponseSchema, {
      archivedAt: null,
      subscribed: body.data.subscribed,
    });
  });
  app.put("/conversations/:conversationId/space", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    const body = setConversationSpaceBodySchema.safeParse(await c.req.json());
    if (!params.success || !body.success)
      return errorResponse("Invalid request.", 400);
    const { conversationId } = params.data;
    const conversation = readMockConversationDetail(conversationId, 1);
    if (!conversation?.isParticipant)
      return errorResponse("Conversation not found.", 404);
    if (
      (conversation.kind !== "thread" && conversation.kind !== "automation") ||
      conversation.parentConversationId
    )
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
      if (
        target.space.visibility === "private" &&
        conversation.surface === "slack"
      )
        return errorResponse(
          "A Slack conversation can't join a private Space.",
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
 * Make the Lead of each mock Space that does not have one yet. The API makes
 * it with its Space, but a mock Lead's first Actor is the signed-in viewer.
 */
function createMockLeads(viewer: User): void {
  const actorIdentity = {
    email: viewer.email,
    fullName: viewer.displayName ?? viewer.email,
  };
  for (const space of mockSpaces.values()) {
    createMockLead({
      actorIdentity,
      events: seededLeadEvents(space.id, actorIdentity) ?? [],
      spaceId: space.id,
      title: space.name,
    });
  }
}

const TREE_STATE_ORDER = ["needs_you", "working", "done"] as const;

/**
 * Roll up the state of a Space's active feed rows, as the API's Space list
 * does.
 */
function spaceState(
  spaceId: string,
): Pick<SpaceReport, "latestTurnFailed" | "treeState"> {
  const rows = readMockConversationFeed().conversations.filter(
    (row) =>
      !row.archivedAt &&
      mockConversationSpaces.get(row.conversationId) === spaceId,
  );
  const states = rows.map(mockTreeState);
  return {
    latestTurnFailed: rows.some((row) => row.latestTurnFailed),
    treeState:
      TREE_STATE_ORDER.find((state) => states.includes(state)) ?? "done",
  };
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
    leadConversationId: mockLeadId(space.id),
  };
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

/** Find the Space of a route, or the API's error for it. */
function findSpace(param: Record<string, string>): MockSpace | Response {
  const params = spaceParamsSchema.safeParse(param);
  if (!params.success) return errorResponse("Invalid route parameters.", 400);
  return (
    readMockSpace(params.data.spaceId) ??
    errorResponse("Space was not found.", 404)
  );
}

/** Build what `GET /spaces` answers for its query, or nothing for a bad one. */
export function readMockSpaceList(query: Record<string, string>) {
  const parsed = spaceListQuerySchema.safeParse(query);
  if (!parsed.success) return undefined;
  const spaces = [...mockSpaces.values()]
    .filter(
      (space) =>
        (parsed.data.membership === "all" || space.viewerMember) &&
        readable(space) &&
        Boolean(space.archivedAt) === parsed.data.archived,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    spaces: spaces.map((space) => ({
      ...view(space),
      ...spaceState(space.id),
    })),
  };
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
    const viewer = c.get("viewer");
    if (!viewer) return errorResponse("Authentication required.", 401);
    createMockLeads(viewer);
    return next();
  });
  app.get("/", (c) => {
    const list = readMockSpaceList(c.req.query());
    if (!list) return errorResponse("Invalid query parameters.", 400);
    return jsonResponse(spaceListSchema, list);
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

      viewerParticipant: true,
      visibility: body.data.visibility,
    };
    mockSpaces.set(space.id, space);
    createMockLeads(c.get("viewer")!);
    return jsonResponse(spaceSchema, view(space), { status: 201 });
  });
  app.get("/:spaceId", (c) => {
    const space = findSpace(c.req.param());
    return space instanceof Response
      ? space
      : jsonResponse(spaceSchema, view(space));
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
