import type { Hono } from "hono";
import type { JuniorApiVariables } from "@sentry/junior/api";
import { errorResponse } from "./errors";

// The API returns at most this many memories per search.
const MOCK_MEMORY_SEARCH_LIMIT = 8;

// Active public memories, newest first, like the API.
const MOCK_MEMORIES = [
  {
    id: "memory-deploy-runbook",
    content:
      "Deploy runbooks live in Notion under Engineering, then Releases. Start with the rollback checklist before any production deploy, and post the deploy link in #deploys.",
  },
  {
    id: "memory-checkout-runbook",
    content:
      "Checkout latency investigations start with the deployment comparison dashboard.",
  },
  {
    id: "memory-release-notes",
    content: "Release notes should include migration risks.",
  },
  { id: "memory-pnpm", content: "Use pnpm for repository commands." },
  {
    id: "memory-incident-reviews",
    content: "Start incident reviews with the customer impact.",
  },
];

/** Mount the mock memory search that Cmd+K and the composer `@` menu read. */
export function registerMockMemorySearchRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/memory/search", (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) return errorResponse("Invalid memory request.", 400);
    return Response.json({ memories: searchMockMemories(query) });
  });
}

/** Find mock memories like the API: each word must start a word of one. */
function searchMockMemories(query: string) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    4,
  );
  return MOCK_MEMORIES.filter((memory) => {
    const words = memory.content.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return (
      terms.length > 0 &&
      terms.every((term) => words.some((word) => word.startsWith(term)))
    );
  }).slice(0, MOCK_MEMORY_SEARCH_LIMIT);
}
