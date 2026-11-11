import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  walkthroughVersionSchema,
  type WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { ACTIVE_CONVERSATION_ID } from "./fixtures";
// Real documents from the first Walkthrough cost runs: one PR, and a stack.
import singleRun from "./walkthroughs/pr3071.json";
import stackRun from "./walkthroughs/stack3089.json";

/** A started fixture shows its generating state for this long. */
const GENERATING_MS = 6_000;

/** Fixed ids that open each state without a click, for visual QA. */
const MOCK_WALKTHROUGH_IDS = {
  generating: "6b0e8f1e-0000-4000-8000-000000000001",
  failed: "6b0e8f1e-0000-4000-8000-000000000002",
} as const;

function readyVersion(run: unknown): WalkthroughVersionResponse {
  // The cost runs read GitHub through a local plugin and had no readable
  // source Conversation. Use the real plugin and link a Conversation, so the
  // "Made in" row shows.
  const version = {
    ...walkthroughVersionSchema.parse(run),
    provider: "github",
  };
  return version.document
    ? {
        ...version,
        document: {
          ...version.document,
          sourceConversationId: ACTIVE_CONVERSATION_ID,
        },
      }
    : version;
}

function pendingVersion(
  ready: WalkthroughVersionResponse,
  id: string,
  status: "generating" | "failed",
): WalkthroughVersionResponse {
  const { completedAt: _completedAt, document: _document, ...rest } = ready;
  return {
    ...rest,
    id,
    status,
    costUsd: status === "generating" ? 0.18 : 0.41,
    ...(status === "failed"
      ? { failureReason: "The Turn ended without a Walkthrough." }
      : undefined),
  };
}

/**
 * Serve Walkthrough fixtures. Starting one returns a generating version that
 * turns ready after a few seconds, so the page shows both states.
 */
export function createMockWalkthroughRoutes(): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  const single = readyVersion(singleRun);
  const stack = readyVersion(stackRun);
  const ready = new Map([single, stack].map((v) => [v.id, v]));
  const startedAtMs = new Map<string, number>();

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      number?: unknown;
    };
    const fixture = stack.codeChanges.some((c) => c.number === body.number)
      ? stack
      : single;
    if (!startedAtMs.has(fixture.id)) startedAtMs.set(fixture.id, Date.now());
    return jsonResponse(
      walkthroughVersionSchema,
      pendingVersion(fixture, fixture.id, "generating"),
      { status: 202 },
    );
  });

  app.get("/:id", (c) => {
    const id = c.req.param("id");
    if (id === MOCK_WALKTHROUGH_IDS.generating) {
      return jsonResponse(
        walkthroughVersionSchema,
        pendingVersion(single, id, "generating"),
      );
    }
    if (id === MOCK_WALKTHROUGH_IDS.failed) {
      return jsonResponse(
        walkthroughVersionSchema,
        pendingVersion(single, id, "failed"),
      );
    }
    const version = ready.get(id);
    if (!version) {
      return c.json({ error: "Walkthrough not found." }, 404);
    }
    const started = startedAtMs.get(id);
    return jsonResponse(
      walkthroughVersionSchema,
      started !== undefined && Date.now() - started < GENERATING_MS
        ? pendingVersion(version, id, "generating")
        : version,
    );
  });

  return app;
}
