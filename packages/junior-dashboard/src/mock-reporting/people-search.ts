import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  conversationInviteBodySchema,
  conversationInviteResponseSchema,
  conversationParamsSchema,
  peopleSearchQuerySchema,
  peopleSearchReportSchema,
  userSearchQuerySchema,
  userSearchReportSchema,
  type ConversationInviteResponse,
  type MentionablePerson,
  type PeopleSearchReport,
  type UserSearchQuery,
  type UserSearchResult,
} from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import { readMockConversationDetail } from "./fixtures";
import { readMockSpace } from "./spaces";

// The API returns at most this many people per search.
const MOCK_PEOPLE_SEARCH_LIMIT = 8;

const MOCK_MENTIONABLE_PEOPLE: MentionablePerson[] = [
  {
    avatarUrl: "/api/people/avatars/mock-casey",
    email: "casey@example.com",
    fullName: "Casey Nguyen",
    hasUser: true,
    slackUserId: "U456",
    slackUserName: "casey",
  },
  {
    avatarUrl: "/api/people/avatars/mock-morgan",
    email: "dev@example.com",
    fullName: "Morgan Lee",
    hasUser: true,
    slackUserId: "U123",
    slackUserName: "morgan",
  },
  // The same person as the mock People directory, so the card is full.
  {
    avatarUrl: "/api/people/avatars/mock-avery",
    email: "avery@sentry.io",
    fullName: "Avery Chen",
    hasUser: true,
    slackUserId: "U789",
    slackUserName: "avery",
  },
  // No verified email: no People page, but still a card.
  {
    fullName: "Sam Ortiz",
    hasUser: true,
    slackUserId: "U234",
    slackUserName: "sam",
  },
  // In Slack but not a User: no feed, so the people picker skips them.
  {
    fullName: "Riley Park",
    slackUserId: "U345",
    slackUserName: "riley",
  },
];

/** The mock people who are Users: the ones the people picker can add. */
const MOCK_USERS: UserSearchResult[] = MOCK_MENTIONABLE_PEOPLE.flatMap(
  (person) =>
    person.hasUser && person.email
      ? [
          {
            ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : undefined),
            email: person.email,
            ...(person.fullName ? { fullName: person.fullName } : undefined),
            slackUserId: person.slackUserId,
            ...(person.slackUserName
              ? { slackUserName: person.slackUserName }
              : undefined),
            userId: `mock-user-${person.slackUserId}`,
          },
        ]
      : [],
);

/** Mount the mock `@` people search, people picker, and Invite routes. */
export function registerMockPeopleSearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/people/user-search", (c) => {
    const query = userSearchQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse("Invalid search query.", 400);
    const members = readMockMemberEmails(query.data, c.get("viewer")?.email);
    if (!members) {
      return errorResponse(
        query.data.spaceId ? "Space was not found." : "Conversation not found.",
        404,
      );
    }
    return jsonResponse(userSearchReportSchema, {
      users: searchMockUsers(query.data, members),
    });
  });
  app.get("/people/search", (c) => {
    const query = peopleSearchQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return errorResponse("Invalid query parameters.", 400);
    }
    return jsonResponse(
      peopleSearchReportSchema,
      searchMockPeople(query.data.q),
    );
  });
  app.post("/conversations/:conversationId/invites", async (c) => {
    const params = conversationParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const body = conversationInviteBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return errorResponse("Invalid request body.", 400);
    }
    const result = inviteMockPerson(
      params.data.conversationId,
      body.data.slackUserId,
    );
    if (result === "conversation") {
      return errorResponse("Conversation not found.", 404);
    }
    if (result === "person") return errorResponse("Person not found.", 404);
    return jsonResponse(conversationInviteResponseSchema, result);
  });
}

/**
 * Find mock people whose name or Slack handle has a word that starts with
 * the query, like the API's prefix search.
 */
function searchMockPeople(query: string): PeopleSearchReport {
  const prefix = query.trim().toLowerCase();
  const people = MOCK_MENTIONABLE_PEOPLE.filter((person) =>
    `${person.fullName ?? ""} ${person.slackUserName ?? ""}`
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.startsWith(prefix)),
  ).slice(0, MOCK_PEOPLE_SEARCH_LIMIT);
  return { people };
}

/**
 * Invite a mock person to a public mock Conversation. Like the API, a
 * private Conversation looks missing.
 */
function inviteMockPerson(
  conversationId: string,
  slackUserId: string,
): ConversationInviteResponse | "conversation" | "person" {
  const detail = readMockConversationDetail(conversationId);
  if (detail?.visibility !== "public") return "conversation";
  const person = MOCK_MENTIONABLE_PEOPLE.find(
    (candidate) => candidate.slackUserId === slackUserId,
  );
  if (!person?.hasUser) return "person";
  const added = !detail.participants?.some(
    (participant) => participant.slackUserId === slackUserId,
  );
  return { added };
}

/**
 * The emails of the people who already belong to the searched Space or
 * Conversation, or nothing when the viewer cannot read it.
 */
function readMockMemberEmails(
  query: UserSearchQuery,
  viewerEmail: string | undefined,
): Set<string> | undefined {
  if (query.spaceId) {
    const space = readMockSpace(query.spaceId);
    if (!space) return undefined;
    return new Set([
      ...space.others.map((member) => member.email),
      ...(space.viewerMember && viewerEmail ? [viewerEmail] : []),
    ]);
  }
  const detail = readMockConversationDetail(query.conversationId!);
  if (!detail) return undefined;
  return new Set(
    (detail.participants ?? []).flatMap((person) =>
      person.email ? [person.email] : [],
    ),
  );
}

/**
 * Rank mock Users like the API: an exact field, then a field or name word
 * that starts with the query, then any match, then by name.
 */
function searchMockUsers(
  query: UserSearchQuery,
  members: ReadonlySet<string>,
): UserSearchResult[] {
  const whole = query.q.toLowerCase().replace(/^@+/, "");
  const rank = (user: UserSearchResult) => {
    const name = (user.fullName ?? "").toLowerCase();
    const fields = [name, user.slackUserName ?? "", user.email];
    if (fields.includes(whole) || user.email.split("@")[0] === whole) return 0;
    if (
      fields.some((field) => field.startsWith(whole)) ||
      name.split(/\s+/).some((word) => word.startsWith(whole))
    ) {
      return 1;
    }
    return 2;
  };
  return MOCK_USERS.filter((user) =>
    `${user.fullName ?? ""} ${user.slackUserName ?? ""} ${user.email}`
      .toLowerCase()
      .includes(whole),
  )
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        (left.fullName ?? "").localeCompare(right.fullName ?? ""),
    )
    .slice(0, query.limit)
    .map(({ slackUserId, ...user }) => ({
      ...user,
      ...(query.conversationId ? { slackUserId } : undefined),
      ...(members.has(user.email) ? { isMember: true as const } : undefined),
    }));
}
