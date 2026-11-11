import { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import type { User } from "@sentry/junior-plugin-api";
import {
  walkthroughAnswerSchema,
  walkthroughAnswersSchema,
  walkthroughQuestionsSchema,
  walkthroughVersionSchema,
  type WalkthroughAnswerResponse,
  type WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { ACTIVE_CONVERSATION_ID } from "./fixtures";
import { createMockConversation } from "./sends";
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
  const document = version.document;
  if (!document) return version;
  // The cost runs predate line links. Add the links the GitHub plugin makes,
  // so review text shows them.
  const excerpts = document.excerpts.map((excerpt) => {
    const layer = document.layers.find((l) => l.pr === excerpt.pr);
    if (!layer) return excerpt;
    const sha = excerpt.side === "head" ? layer.headSha : layer.baseSha;
    return {
      ...excerpt,
      url: `https://github.com/${document.repository}/blob/${sha}/${excerpt.path}#L${excerpt.start}`,
    };
  });
  return {
    ...version,
    document: {
      ...document,
      excerpts,
      sourceConversationId: ACTIVE_CONVERSATION_ID,
    },
  };
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

/** Add one web message to a mock Conversation and answer like the API. */
type MockSend = (
  conversationId: string,
  body: { idempotencyKey: string; message: string },
  viewer: User,
) => Promise<Response>;

/**
 * Serve Walkthrough fixtures. Starting one returns a generating version that
 * turns ready after a few seconds, so the page shows both states. Questions
 * get the fixed reply of every mock send.
 */
export function createMockWalkthroughRoutes(options: { send: MockSend }): Hono<{
  Variables: JuniorApiVariables;
}> {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  const single = readyVersion(singleRun);
  const stack = readyVersion(stackRun);
  const ready = new Map([single, stack].map((v) => [v.id, v]));
  const startedAtMs = new Map<string, number>();
  // Answers and questions live until the dev server restarts, like a fresh
  // reviewer.
  const answers = new Map<string, Map<string, WalkthroughAnswerResponse>>();
  const questions = new Map<string, string>();
  const questionsKey = (id: string, viewer: User) => `${id}\u0000${viewer.id}`;

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

  app.get("/:id/answers", (c) =>
    jsonResponse(walkthroughAnswersSchema, {
      answers: [...(answers.get(c.req.param("id"))?.values() ?? [])],
    }),
  );

  app.put("/:id/answers/:decisionId", async (c) => {
    const id = c.req.param("id");
    if (!ready.has(id)) return c.json({ error: "Walkthrough not found." }, 404);
    const body = (await c.req.json()) as {
      value: "agree" | "change";
      note?: string;
    };
    const answer = walkthroughAnswerSchema.parse({
      ...body,
      decisionId: c.req.param("decisionId"),
      updatedAt: new Date().toISOString(),
    });
    const mine = answers.get(id) ?? new Map();
    mine.set(answer.decisionId, answer);
    answers.set(id, mine);
    return jsonResponse(walkthroughAnswerSchema, answer);
  });

  app.get("/:id/questions", (c) => {
    const viewer = c.get("viewer");
    const conversationId = viewer
      ? questions.get(questionsKey(c.req.param("id"), viewer))
      : undefined;
    return jsonResponse(
      walkthroughQuestionsSchema,
      conversationId ? { conversationId } : {},
    );
  });

  app.post("/:id/questions", async (c) => {
    const viewer = c.get("viewer");
    if (!viewer) return c.json({ error: "Sign in to ask." }, 401);
    const id = c.req.param("id");
    const version = ready.get(id);
    if (!version) return c.json({ error: "Walkthrough not found." }, 404);
    const body = (await c.req.json()) as {
      idempotencyKey: string;
      message: string;
    };
    const key = questionsKey(id, viewer);
    const conversationId =
      questions.get(key) ??
      createMockConversation({
        actorIdentity: { email: viewer.email },
        idempotencyKey: `walkthrough-questions:${id}`,
        message: body.message,
        title: `Questions about the Walkthrough of #${version.codeChanges.at(-1)?.number}`,
        unlisted: true,
        visibility: "private",
      });
    questions.set(key, conversationId);
    const accepted = await options.send(conversationId, body, viewer);
    return new Response(accepted.body, {
      status: 202,
      headers: accepted.headers,
    });
  });

  return app;
}
