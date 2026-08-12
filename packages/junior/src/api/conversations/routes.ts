import { Hono } from "hono";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  acceptedConversationMessageSchema,
  archiveConversationBodySchema,
  archiveConversationResponseSchema,
  conversationAttachmentParamsSchema,
  conversationDetailQuerySchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  conversationPendingMessagesReportSchema,
  conversationStatsReportSchema,
  createConversationBodySchema,
  createConversationMessageBodySchema,
} from "../schema/conversation";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { archiveConversation } from "./archive";
import {
  conversationAttachmentHeaders,
  requireConversationAttachment,
} from "./attachments";
import {
  appendConversationMessageForViewer,
  createConversationForViewer,
} from "./create";
import { readConversationDetail } from "./detail";
import { readConversationEvents } from "./event-list";
import { readConversationFeed } from "./list";
import { requireConversationPendingMessages } from "./pending-messages";
import { readConversationStats } from "./stats";

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(options?: {
  attachmentStorage?: AttachmentStorage;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/",
    validateRequest(
      "query",
      conversationFeedQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { actorEmail } = context.req.valid("query");
      const viewer = context.get("viewer");
      return jsonResponse(
        conversationFeedSchema,
        await readConversationFeed({
          ...(actorEmail ? { actorEmail } : {}),
          ...(viewer ? { viewer } : {}),
        }),
      );
    },
  );

  app.get("/stats", async () =>
    jsonResponse(conversationStatsReportSchema, await readConversationStats()),
  );

  app.post(
    "/",
    requireViewer,
    validateRequest(
      "json",
      createConversationBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const body = context.req.valid("json");
      return jsonResponse(
        acceptedConversationMessageSchema,
        await createConversationForViewer(viewer, body),
      );
    },
  );

  app.post(
    "/:conversationId/messages",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      createConversationMessageBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        acceptedConversationMessageSchema,
        await appendConversationMessageForViewer(viewer, conversationId, body),
      );
    },
  );

  app.patch(
    "/:conversationId/archive",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      archiveConversationBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        archiveConversationResponseSchema,
        await archiveConversation(conversationId, body),
      );
    },
  );

  app.get(
    "/:conversationId/events",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "query",
      conversationEventsQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const { before, limit } = context.req.valid("query");
      const viewer = context.get("viewer");
      const report = await readConversationEvents(conversationId, before, {
        limit,
        ...(viewer ? { viewer } : {}),
      });
      if (!report) throwApiError(404, "Conversation not found.");
      return jsonResponse(conversationEventPageSchema, report);
    },
  );

  app.get(
    "/:conversationId/pending-messages",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      return jsonResponse(
        conversationPendingMessagesReportSchema,
        await requireConversationPendingMessages(conversationId, {
          viewer,
        }),
      );
    },
  );

  app.get(
    "/:conversationId/attachments/:attachmentId",
    validateRequest(
      "param",
      conversationAttachmentParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { attachmentId, conversationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      const opened = await requireConversationAttachment({
        attachmentId,
        conversationId,
        ...(options?.attachmentStorage
          ? { storage: options.attachmentStorage }
          : {}),
        ...(viewer ? { viewer } : {}),
      });
      return new Response(opened.body, {
        headers: conversationAttachmentHeaders({
          bytes: opened.attachment.bytes,
          contentType: opened.contentType,
          filename: opened.attachment.filename,
        }),
      });
    },
  );

  app.get(
    "/:conversationId",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "query",
      conversationDetailQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const query = context.req.valid("query");
      const viewer = context.get("viewer");
      const report = await readConversationDetail(conversationId, {
        ...query,
        ...(viewer ? { viewer } : {}),
      });
      if (!report) throwApiError(404, "Conversation not found.");
      return jsonResponse(conversationDetailReportSchema, report);
    },
  );

  return app;
}
