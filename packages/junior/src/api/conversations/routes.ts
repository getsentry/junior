import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  acceptedConversationMessageSchema,
  forkConversationBodySchema,
  forkConversationResponseSchema,
  conversationAttachmentParamsSchema,
  conversationDetailQuerySchema,
  CONVERSATION_DETAIL_VERSION_HEADER,
  CONVERSATION_VERSION_HEADER,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationFeedQuerySchema,
  conversationParamsSchema,
  createConversationBodySchema,
  createConversationMessageBodySchema,
} from "../schema/conversation";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import {
  attachmentUploadParamsSchema,
  attachmentUploadSchema,
  createAttachmentUploadBodySchema,
} from "../schema/conversation-attachment-upload";
import { conversationFeedSchema } from "../schema/conversation-feed";
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
  conversationDeliveryBodySchema,
  conversationDeliveryResponseSchema,
} from "../schema/conversation-delivery";
import {
  conversationSubscriptionBodySchema,
  conversationSubscriptionResponseSchema,
} from "../schema/conversation-subscription";
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
import {
  renameConversationBodySchema,
  renameConversationResponseSchema,
} from "../schema/conversation-title";
import { conversationOutlineSchema } from "../schema/conversation-outline";
import { conversationStatsReportSchema } from "../schema/conversation-stats";
import { stopConversationTurnResponseSchema } from "../schema/conversation-stop";
import {
  attachObjectLinkBodySchema,
  attachObjectLinkResponseSchema,
} from "../schema/object-link";
import { attachObjectLink } from "../objects/attach";
import {
  continueConversationInSlackBodySchema,
  continueConversationInSlackResponseSchema,
} from "../schema/conversation-continue-in-slack";
import { conversationChildAgentsReportSchema } from "../schema/child-agent";
import { conversationWatchesReportSchema } from "../schema/watch";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { createConversationAccessReader } from "./access";
import { reportConversationRead } from "./read-position";
import { archiveConversation } from "./archive";
import { catchUpOnConversation } from "./catch-up";
import { pinConversation, reorderPinnedConversations } from "./pin";
import { setConversationSubscription } from "./subscription";
import { setConversationDeliveryForViewer } from "./delivery";
import { renameConversation } from "./rename";
import {
  archiveViewerDoneConversations,
  setConversationAutoArchive,
} from "./auto-archive";
import { requireConversationChildAgents } from "./child-agents";
import { continueConversationInSlackForViewer } from "./continue-in-slack";
import { conversationAttachmentResponse } from "./attachments";
import {
  createAttachmentUploadForViewer,
  writeAttachmentUploadForViewer,
} from "./attachment-uploads";
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
import { readConversationOutline } from "./outline";
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
  // Files go to attachment storage first, so a Message body holds only text
  // and upload ids.
  const messageBodyLimit = bodyLimit({ maxSize: 262_144 });

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
    "/attachment-uploads",
    requireViewer,
    bodyLimit({ maxSize: 8_192 }),
    validateRequest(
      "json",
      createAttachmentUploadBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        attachmentUploadSchema,
        await createAttachmentUploadForViewer(
          context.get("viewer"),
          context.req.valid("json"),
          options.attachmentStorage,
        ),
      ),
  );

  app.put(
    "/attachment-uploads/:uploadId",
    requireViewer,
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: () => {
        throwApiError(
          413,
          `Files must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or less.`,
        );
      },
    }),
    validateRequest(
      "param",
      attachmentUploadParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      await writeAttachmentUploadForViewer({
        readBody: () => context.req.arrayBuffer(),
        storage: options.attachmentStorage,
        uploadId: context.req.valid("param").uploadId,
        viewer: context.get("viewer"),
      });
      return context.body(null, 204);
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
    "/:conversationId/continue-in-slack",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      continueConversationInSlackBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        continueConversationInSlackResponseSchema,
        await continueConversationInSlackForViewer(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
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

  app.patch(
    "/:conversationId/delivery",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      conversationDeliveryBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        conversationDeliveryResponseSchema,
        await setConversationDeliveryForViewer(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
  );

  app.patch(
    "/:conversationId/subscription",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      conversationSubscriptionBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        conversationSubscriptionResponseSchema,
        await setConversationSubscription(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
  );

  app.patch(
    "/:conversationId/title",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      renameConversationBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        renameConversationResponseSchema,
        await renameConversation(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/:conversationId/annotations",
    requireViewer,
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    validateRequest(
      "json",
      attachObjectLinkBodySchema,
      "Invalid request body.",
    ),
    async (context) =>
      jsonResponse(
        attachObjectLinkResponseSchema,
        await attachObjectLink(
          context.get("viewer"),
          context.req.valid("param").conversationId,
          context.req.valid("json").url,
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
        await reportConversationRead(viewer, conversationId, body),
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
    "/:conversationId/outline",
    validateRequest(
      "param",
      conversationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { conversationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      const outline = await readConversationOutline(
        conversationId,
        viewer ? { viewer } : undefined,
      );
      if (!outline) throwApiError(404, "Conversation not found.");
      return jsonResponse(conversationOutlineSchema, outline);
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
      return await conversationAttachmentResponse({
        attachmentId,
        conversationId,
        range: context.req.header("range"),
        storage: options.attachmentStorage,
        ...(viewer ? { viewer } : undefined),
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
      // The mailbox and the detail state share one access read.
      const readAccess = createConversationAccessReader(getDb(), viewer);
      const readMailbox = () =>
        requireConversationPendingMessages(conversationId, {
          readAccess,
          ...viewerOptions,
        });
      const readVersion = () =>
        readConversationDetailEtag(conversationId, {
          limit: query.limit,
          readAccess,
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
            [CONVERSATION_VERSION_HEADER]: version.version,
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
        ...(version
          ? { stored: { record: version.record, state: version.state } }
          : undefined),
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
