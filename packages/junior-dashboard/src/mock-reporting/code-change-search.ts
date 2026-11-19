import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  codeChangeSearchQuerySchema,
  codeChangeSearchReportSchema,
  type CodeChangeSearchReport,
  type MentionableCodeChange,
} from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";

// The API returns at most this many changes per search.
const MOCK_CODE_CHANGE_SEARCH_LIMIT = 8;

function mockChange(
  repository: string,
  number: number,
  title: string,
  state: MentionableCodeChange["state"],
  draft = false,
): MentionableCodeChange {
  return {
    draft,
    number,
    repository,
    state,
    title,
    url: `https://github.com/${repository}/pull/${number}`,
  };
}

// Newest activity first, like the API.
const MOCK_CODE_CHANGES: MentionableCodeChange[] = [
  mockChange(
    "getsentry/junior",
    3842,
    "Link pull requests from the composer",
    "open",
  ),
  mockChange(
    "getsentry/junior",
    3838,
    "Show reference chips in Messages",
    "open",
    true,
  ),
  mockChange(
    "getsentry/sentry-docs",
    15120,
    "Document composer references",
    "open",
  ),
  mockChange(
    "getsentry/junior",
    3760,
    "Mention people with @ in a Lexical composer",
    "merged",
  ),
  mockChange(
    "getsentry/sentry-docs",
    15077,
    "Fix broken links in the Slack guide",
    "merged",
  ),
  mockChange("getsentry/junior", 3701, "Try a textarea composer", "closed"),
];

/** Mount the mock `#` code change search route. */
export function registerMockCodeChangeSearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/code/changes/search", (c) => {
    const query = codeChangeSearchQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse("Invalid search query.", 400);
    return jsonResponse(
      codeChangeSearchReportSchema,
      searchMockCodeChanges(query.data.q),
    );
  });
}

/**
 * Find mock changes like the API: digits, with an optional `#`, match the
 * start of the number. Each other word must start a word of the title or
 * the repository name.
 */
function searchMockCodeChanges(query: string): CodeChangeSearchReport {
  const number = /^#?(\d+)$/.exec(query.trim())?.[1];
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const changes = MOCK_CODE_CHANGES.filter((change) => {
    if (number) return String(change.number).startsWith(number);
    const words = `${change.number} ${change.title ?? ""} ${change.repository}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u);
    return (
      terms.length > 0 &&
      terms.every((term) => words.some((word) => word.startsWith(term)))
    );
  }).slice(0, MOCK_CODE_CHANGE_SEARCH_LIMIT);
  return { changes };
}
