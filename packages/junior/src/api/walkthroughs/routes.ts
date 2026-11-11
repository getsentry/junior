import { Hono } from "hono";
import type { User } from "@sentry/junior-plugin-api";
import { getAttachmentStorage } from "@/chat/attachments/storage";
import { getDb } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  readWalkthroughAnswers,
  saveWalkthroughAnswer,
  type WalkthroughAnswer,
} from "@/chat/walkthroughs/answers";
import { startWalkthrough } from "@/chat/walkthroughs/generation";
import {
  getWalkthroughVersion,
  readWalkthroughCostUsd,
  readWalkthroughDocument,
  type WalkthroughVersion,
} from "@/chat/walkthroughs/store";
import { readConversationAccessFromSql } from "../conversations/access";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  startWalkthroughBodySchema,
  walkthroughAnswerBodySchema,
  walkthroughAnswerParamsSchema,
  walkthroughAnswerSchema,
  walkthroughAnswersSchema,
  walkthroughParamsSchema,
  walkthroughVersionSchema,
  type WalkthroughAnswerResponse,
  type WalkthroughVersionResponse,
} from "../schema/walkthrough";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

async function walkthroughResponse(
  version: WalkthroughVersion,
): Promise<WalkthroughVersionResponse> {
  const [costUsd, document] = await Promise.all([
    readWalkthroughCostUsd(version),
    version.status === "ready"
      ? readWalkthroughDocument(getAttachmentStorage(), version)
      : undefined,
  ]);
  return {
    id: version.id,
    status: version.status,
    provider: version.provider,
    repository: version.repository,
    codeChanges: version.codeChanges.map(
      ({ body: _body, ...change }) => change,
    ),
    createdAt: version.createdAt.toISOString(),
    ...(costUsd !== undefined ? { costUsd } : undefined),
    ...(version.failureReason
      ? { failureReason: version.failureReason }
      : undefined),
    ...(version.completedAt
      ? { completedAt: version.completedAt.toISOString() }
      : undefined),
    ...(document ? { document } : undefined),
  };
}

/**
 * A document quotes its source Conversation. Generation reads only a public
 * source, but the source can turn private later, so check again on read.
 */
async function canReadSource(
  version: WalkthroughVersion,
  viewer: User,
): Promise<boolean> {
  if (!version.sourceConversationId) return true;
  const access = (
    await readConversationAccessFromSql(
      getDb(),
      [version.sourceConversationId],
      viewer,
    )
  ).get(version.sourceConversationId);
  return Boolean(
    access?.visibility === "public" || access?.canViewPrivateContent,
  );
}

/** Read a version the viewer may see, or fail with 404. */
async function readableVersion(
  id: string,
  viewer: User,
): Promise<WalkthroughVersion> {
  const version = await getWalkthroughVersion(id);
  if (!version || !(await canReadSource(version, viewer))) {
    throwApiError(404, "Walkthrough not found.");
  }
  return version;
}

function answerResponse(answer: WalkthroughAnswer): WalkthroughAnswerResponse {
  return {
    decisionId: answer.decisionId,
    value: answer.value,
    ...(answer.note ? { note: answer.note } : undefined),
    updatedAt: answer.updatedAt.toISOString(),
  };
}

/**
 * Create routes that start and read Walkthroughs. They return 404 unless the
 * app enables the `walkthroughs` experiment, and a Walkthrough generates only
 * when a person asks for it here.
 */
export function createWalkthroughRoutes(options: {
  queue: ConversationWorkQueue;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.use("*", async function requireWalkthroughsExperiment(_context, next) {
    if (!isExperimentalFeatureEnabled("walkthroughs")) {
      throwApiError(404, "Resource not found.");
    }
    await next();
  });

  app.post(
    "/",
    requireViewer,
    validateRequest(
      "json",
      startWalkthroughBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const body = context.req.valid("json");
      const version = await startWalkthrough({
        ...body,
        viewer: context.get("viewer"),
        queue: options.queue,
      });
      if (!version) throwApiError(404, "Code change not found.");
      if (!(await canReadSource(version, context.get("viewer")))) {
        throwApiError(404, "Walkthrough not found.");
      }
      return jsonResponse(
        walkthroughVersionSchema,
        await walkthroughResponse(version),
        { status: 202 },
      );
    },
  );

  app.get(
    "/:id",
    requireViewer,
    validateRequest(
      "param",
      walkthroughParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const version = await readableVersion(
        context.req.valid("param").id,
        context.get("viewer"),
      );
      return jsonResponse(
        walkthroughVersionSchema,
        await walkthroughResponse(version),
      );
    },
  );

  // Answers belong to the viewer. Nobody reads another reviewer's answers.
  app.get(
    "/:id/answers",
    requireViewer,
    validateRequest(
      "param",
      walkthroughParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const version = await readableVersion(
        context.req.valid("param").id,
        viewer,
      );
      const answers = await readWalkthroughAnswers({
        versionId: version.id,
        userId: viewer.id,
      });
      return jsonResponse(walkthroughAnswersSchema, {
        answers: answers.map(answerResponse),
      });
    },
  );

  app.put(
    "/:id/answers/:decisionId",
    requireViewer,
    validateRequest(
      "param",
      walkthroughAnswerParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      walkthroughAnswerBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { id, decisionId } = context.req.valid("param");
      const version = await readableVersion(id, viewer);
      // Only a ready version has decisions. An unknown decision id stays
      // with its reviewer and never renders, so it is not checked against
      // the stored document.
      if (version.status !== "ready") {
        throwApiError(409, "Walkthrough is not ready.");
      }
      const answer = await saveWalkthroughAnswer({
        ...context.req.valid("json"),
        versionId: version.id,
        userId: viewer.id,
        decisionId,
      });
      return jsonResponse(walkthroughAnswerSchema, answerResponse(answer));
    },
  );

  return app;
}
