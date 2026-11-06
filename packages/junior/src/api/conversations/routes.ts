import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  acceptedConversationMessageSchema,
  forkConversationBodySchema,
  forkConversationResponseSchema,
  conversationAttachmentParamsSchema,
  conversationDetailQuerySchema,
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  createConversationBodySchema,
  createConversationMessageBodySchema,
} from "../schema/conversation";
import {
  conversationCatchUpBodySchema,
  conversationCatchUpSchema,
} from "../schema/conversation-catch-up";
import {
  pinConversationBodySchema,
  pinConversationResponseSchema,
  reorderPinnedConversationsBodySchema,
  reorderPinnedConversationsResponseSchema,
} from "../schema/conversation-pin";
import {
  archiveConversationBodySchema,
  archiveConversationResponseSchema,
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
} from "../schema/conversation-archive";
import {
  cancelConversationPendingMessagesBodySchema,
  cancelConversationPendingMessagesResponseSchema,
  steerConversationPendingMessagesBodySchema,
  steerConversationPendingMessagesResponseSchema,
  conversationDetailWithMailboxReportSchema,
  conversationPendingMessagesReportSchema,
  conversationUnchangedDetailWithMailboxSchema,
} from "../schema/conversation-pending-messages";
import { conversationReadPositionSchema } from "../schema/conversation-read-position";
import { conversationStatsReportSchema } from "../schema/conversation-stats";
import { stopConversationTurnResponseSchema } from "../schema/conversation-stop";
import { conversationChildAgentsReportSchema } from "../schema/child-agent";
import { conversationWatchesReportSchema } from "../schema/watch";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { archiveConversation } from "./archive";
import { catchUpOnConversation } from "./catch-up";
import { pinConversation, reorderPinnedConversations } from "./pin";
import {
  archiveViewerDoneConversations,
  setConversationAutoArchive,
} from "./auto-archive";
import { requireConversationChildAgents } from "./child-agents";
import {
  conversationAttachmentHeaders,
  requireConversationAttachment,
} from "./attachments";
import {
  appendConversationMessageForViewer,
  createConversationForViewer,
  type WebInputServices,
} from "./create";
import { readConversationDetail } from "./detail";
import { readConversationDetailEtag } from "./detail-etag";
import { forkConversationForViewer, keepQuickQuestionForViewer } from "./fork";
import { readConversationEvents } from "./event-list";
import { readConversationFeed } from "./list";
import { markConversationRead } from "./read-position";
import { cancelConversationPendingMessagesForViewer } from "./cancel-pending-messages";
import { steerConversationPendingMessagesForViewer } from "./steer-pending-messages";
import { requireConversationPendingMessages } from "./pending-messages";
import { readConversationStats } from "./stats";
import { stopConversationTurnForViewer } from "./stop";
import { requireConversationWatches } from "./watches";

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(
  options: WebInputServices,
): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  const messageBodyLimit = bodyLimit({
    maxSize: 4_450_000,
    onError: () => {
      throwApiError(413, "Images must total 3 MB or less.");
    },
  });

  app.get(
    "/",
    validateRequest(
      "query",
      conversationFeedQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { actorEmail, codeRepositoryId, cursor, q, status } =
        context.req.valid("query");
      const viewer = context.get("viewer");
      return jsonResponse(
        conversationFeedSchema,
        await readConversationFeed({
          ...(actorEmail ? { actorEmail } : undefined),
          ...(codeRepositoryId ? { codeRepositoryId } : undefined),
          ...(cursor ? { cursor } : undefined),
          ...(q ? { q } : undefined),
          status,
          ...(viewer ? { viewer } : undefined),
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
    messageBodyLimit,
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
        await createConversationForViewer(viewer, body, options),
      );
    },
  );

  app.post(
    "/:conversationId/messages",
    requireViewer,
    messageBodyLimit,
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
        await appendConversationMessageForViewer(
          viewer,
          conversationId,
          body,
          options,
        ),
      );
    },
  );

  app.post(
    "/:conversationId/stop",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      return jsonResponse(
        stopConversationTurnResponseSchema,
        await stopConversationTurnForViewer(viewer, conversationId, options),
      );
    },
  );

  app.post(
    "/:conversationId/forks",
    requireViewer,
    // A Quick question quote is up to 4,000 characters.
    bodyLimit({ maxSize: 32_768 }),
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      forkConversationBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        forkConversationResponseSchema,
        await forkConversationForViewer(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/:conversationId/quick-question/keep",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) =>
      jsonResponse(
        forkConversationResponseSchema,
        await keepQuickQuestionForViewer(
          context.get("viewer"),
          context.req.valid("param").conversationId,
        ),
      ),
  );

  app.patch(
    "/:conversationId/archive",
    requireViewer,
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
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        archiveConversationResponseSchema,
        await archiveConversation(viewer, conversationId, body),
      );
    },
  );

  app.patch(
    "/:conversationId/pin",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest("json", pinConversationBodySchema, "Invalid request body."),
    async (context) =>
      jsonResponse(
        pinConversationResponseSchema,
        await pinConversation(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
  );

  app.put(
    "/:conversationId/read-position",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      conversationReadPositionSchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        conversationReadPositionSchema,
        await markConversationRead(viewer, conversationId, body),
      );
    },
  );

  app.put(
    "/pin-order",
    requireViewer,
    validateRequest(
      "json",
      reorderPinnedConversationsBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        reorderPinnedConversationsResponseSchema,
        await reorderPinnedConversations(
          context.get("viewer"),
          context.req.valid("json"),
        ),
      ),
  );

  app.post("/archive-done", requireViewer, async (context) =>
    jsonResponse(
      archiveDoneConversationsResponseSchema,
      await archiveViewerDoneConversations(context.get("viewer")),
    ),
  );

  app.patch(
    "/:conversationId/auto-archive",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      conversationAutoArchiveSchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        conversationAutoArchiveSchema,
        await setConversationAutoArchive(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json").autoArchive,
        ),
      ),
  );

  app.post(
    "/:conversationId/catch-up",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      conversationCatchUpBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        conversationCatchUpSchema,
        await catchUpOnConversation(viewer, conversationId, body),
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
      const { limit, ...boundary } = context.req.valid("query");
      const viewer = context.get("viewer");
      const report = await readConversationEvents(conversationId, boundary, {
        limit,
        ...(viewer ? { viewer } : undefined),
      });
      if (!report) throwApiError(404, "Conversation not found.");
      return jsonResponse(conversationEventPageSchema, report);
    },
  );

  app.get(
    "/:conversationId/agents",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      return jsonResponse(
        conversationChildAgentsReportSchema,
        await requireConversationChildAgents(conversationId, { viewer }),
      );
    },
  );

  app.get(
    "/:conversationId/watches",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      return jsonResponse(
        conversationWatchesReportSchema,
        await requireConversationWatches(conversationId, { viewer }),
      );
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

  app.post(
    "/:conversationId/pending-messages/steer",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      steerConversationPendingMessagesBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        steerConversationPendingMessagesResponseSchema,
        await steerConversationPendingMessagesForViewer(
          viewer,
          conversationId,
          body,
        ),
      );
    },
  );

  app.delete(
    "/:conversationId/pending-messages",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      cancelConversationPendingMessagesBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { conversationId } = context.req.valid("param");
      const body = context.req.valid("json");
      return jsonResponse(
        cancelConversationPendingMessagesResponseSchema,
        await cancelConversationPendingMessagesForViewer(
          viewer,
          conversationId,
          body,
        ),
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
        storage: options.attachmentStorage,
        ...(viewer ? { viewer } : undefined),
      });
      return new Response(opened.body, {
        headers: conversationAttachmentHeaders({
          bytes: opened.attachment.bytes,
          contentType: opened.attachment.contentType,
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
      const { mailbox: withMailbox, ...query } = context.req.valid("query");
      const viewer = context.get("viewer");
      const viewerOptions = viewer ? { viewer } : undefined;
      const sentVersion = context.req.header(
        CONVERSATION_DETAIL_VERSION_HEADER,
      );
      const readMailbox = () =>
        requireConversationPendingMessages(conversationId, viewerOptions);
      const readVersion = () =>
        readConversationDetailEtag(conversationId, {
          limit: query.limit,
          ...viewerOptions,
        });
      // Read the mailbox before history, as two separate reads would, so
      // input that moves from the mailbox to history is in at least one.
      // Polls send the last token: compare it before the report is built,
      // because building the report is the expensive part. A poll that may
      // answer with the mailbox alone reads the token after the mailbox:
      // input that left the mailbox is then in history, which changes it.
      const [mailbox, version] =
        withMailbox && sentVersion
          ? [await readMailbox(), await readVersion()]
          : await Promise.all([
              withMailbox ? readMailbox() : undefined,
              readVersion(),
            ]);
      const headers = version
        ? {
            "cache-control": "private, no-store",
            [CONVERSATION_DETAIL_VERSION_HEADER]: version.etag,
          }
        : undefined;
      if (version && sentVersion === version.etag) {
        return mailbox
          ? jsonResponse(
              conversationUnchangedDetailWithMailboxSchema,
              { mailbox, unchanged: true },
              { headers },
            )
          : new Response(null, { status: 304, headers });
      }
      const report = await readConversationDetail(conversationId, {
        ...query,
        ...(version ? { state: version.state } : undefined),
        ...viewerOptions,
      });
      if (!report) throwApiError(404, "Conversation not found.");
      const init = headers ? { headers } : undefined;
      return mailbox
        ? jsonResponse(
            conversationDetailWithMailboxReportSchema,
            { ...report, mailbox },
            init,
          )
        : jsonResponse(conversationDetailReportSchema, report, init);
    },
  );

  return app;
}
