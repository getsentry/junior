import { Hono } from "hono";
import type { User } from "@sentry/junior-plugin-api";
import { getAttachmentStorage } from "@/chat/attachments/storage";
import { getDb } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
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
  walkthroughParamsSchema,
  walkthroughVersionSchema,
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
      const version = await getWalkthroughVersion(
        context.req.valid("param").id,
      );
      if (!version || !(await canReadSource(version, context.get("viewer")))) {
        throwApiError(404, "Walkthrough not found.");
      }
      return jsonResponse(
        walkthroughVersionSchema,
        await walkthroughResponse(version),
      );
    },
  );

  return app;
}
