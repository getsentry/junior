import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  conversationInviteBodySchema,
  conversationInviteResponseSchema,
  conversationParamsSchema,
  peopleSearchQuerySchema,
  peopleSearchReportSchema,
  type ConversationInviteResponse,
  type MentionablePerson,
  type PeopleSearchReport,
} from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import { readMockConversationDetail } from "./fixtures";

// The API returns at most this many people per search.
const MOCK_PEOPLE_SEARCH_LIMIT = 8;

const MOCK_MENTIONABLE_PEOPLE: MentionablePerson[] = [
  {
    avatarUrl: "/api/people/avatars/mock-casey",
    email: "casey@example.com",
    fullName: "Casey Nguyen",
    slackUserId: "U456",
    slackUserName: "casey",
  },
  {
    avatarUrl: "/api/people/avatars/mock-morgan",
    email: "dev@example.com",
    fullName: "Morgan Lee",
    slackUserId: "U123",
    slackUserName: "morgan",
  },
  // The same person as the mock People directory, so the card is full.
  {
    avatarUrl: "/api/people/avatars/mock-avery",
    email: "avery@sentry.io",
    fullName: "Avery Chen",
    slackUserId: "U789",
    slackUserName: "avery",
  },
  {
    email: "sam@example.com",
    fullName: "Sam Ortiz",
    slackUserId: "U234",
    slackUserName: "sam",
  },
];

/** Mount the mock `@` people search and Invite routes. */
export function registerMockPeopleSearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
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
  if (!person) return "person";
  const added = !detail.participants?.some(
    (participant) => participant.slackUserId === slackUserId,
  );
  return { added };
}
