/**
 * Requests that the fixture sends to the dashboard API as a signed-in person.
 */
import type { Hono } from "hono";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  attachmentUploadSchema,
  leadSchema,
  steerConversationPendingMessagesResponseSchema,
} from "@/api/schema";
import type { FileInput, WebMessageInput } from "./inputs";
import { VIEWER_HEADER } from "./results";

/**
 * Upload files as the dashboard does before a send, and return the upload
 * ids for the message.
 */
async function uploadWebFiles(
  api: Hono<JuniorApiEnv>,
  message: {
    conversationId?: string;
    files: FileInput[];
    idempotencyKey: string;
    viewerEmail: string;
  },
): Promise<string[]> {
  const ids: string[] = [];
  /* oxlint-disable no-await-in-loop -- Upload in order, so upload ids keep a stable order across recorded runs. */
  for (const file of message.files) {
    if (!file.content) throw new Error(`File ${file.name} needs content`);
    const response = await api.request(
      "/api/conversations/attachment-uploads",
      jsonRequest(message.viewerEmail, {
        bytes: file.content.byteLength,
        contentType: file.mimeType,
        ...(message.conversationId
          ? { conversationId: message.conversationId }
          : undefined),
        filename: file.name,
        idempotencyKey: message.idempotencyKey,
      }),
    );
    if (response.status !== 200) {
      throw new Error(
        `Upload returned ${response.status}: ${await response.text()}`,
      );
    }
    const { target, uploadId } = attachmentUploadSchema.parse(
      await response.json(),
    );
    const body = new Uint8Array(file.content);
    // Storage that signs browser writes returns its own URL. Other storage
    // takes the bytes through the API.
    const write = target.url.startsWith("/")
      ? await api.request(target.url, {
          body,
          headers: { ...target.headers, [VIEWER_HEADER]: message.viewerEmail },
          method: target.method,
        })
      : await fetch(target.url, {
          body,
          headers: target.headers,
          method: target.method,
        });
    if (!write.ok) throw new Error(`Upload write returned ${write.status}`);
    ids.push(uploadId);
  }
  /* oxlint-enable no-await-in-loop */
  return ids;
}

/** A JSON POST signed in as `viewerEmail`. */
export function jsonRequest(viewerEmail: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [VIEWER_HEADER]: viewerEmail,
    },
    body: JSON.stringify(body),
  };
}

/** Read the accepted message of a web message post, or fail the test. */
async function expectAccepted(response: Response) {
  if (response.status !== 200) {
    throw new Error(
      `Web message returned ${response.status}: ${await response.text()}`,
    );
  }
  return acceptedConversationMessageSchema.parse(await response.json());
}

/**
 * Steer one queued web message into the running turn, as the steer action in
 * the dashboard queue does.
 */
async function steerQueuedWebMessage(
  api: Hono<JuniorApiEnv>,
  args: {
    conversationId: string;
    inboundMessageId: string;
    viewerEmail: string;
  },
): Promise<void> {
  const response = await api.request(
    `/api/conversations/${encodeURIComponent(args.conversationId)}/pending-messages/steer`,
    jsonRequest(args.viewerEmail, {
      inboundMessageIds: [args.inboundMessageId],
    }),
  );
  if (response.status !== 200) {
    throw new Error(
      `Steer returned ${response.status}: ${await response.text()}`,
    );
  }
  const result = steerConversationPendingMessagesResponseSchema.parse(
    await response.json(),
  );
  // An empty result means Junior read the message before the steer.
  if (!result.steeredInboundMessageIds.includes(args.inboundMessageId)) {
    throw new Error("The message left the queue before the steer");
  }
}

/**
 * Send one message as the dashboard composer does: upload its files, post
 * it, and steer it when the input asks. With no `conversationId`, the post
 * creates the Conversation.
 */
export async function postWebMessage(
  api: Hono<JuniorApiEnv>,
  message: {
    conversationId?: string | undefined;
    idempotencyKey: string;
    input: WebMessageInput;
    viewerEmail: string;
  },
): Promise<void> {
  const { conversationId, idempotencyKey, input, viewerEmail } = message;
  const uploadIds = input.files?.length
    ? await uploadWebFiles(api, {
        ...(conversationId ? { conversationId } : undefined),
        files: input.files,
        idempotencyKey,
        viewerEmail,
      })
    : undefined;
  const accepted = await expectAccepted(
    await api.request(
      conversationId
        ? `/api/conversations/${encodeURIComponent(conversationId)}/messages`
        : "/api/conversations",
      jsonRequest(viewerEmail, {
        idempotencyKey,
        message: input.text,
        ...(uploadIds ? { uploadIds } : undefined),
      }),
    ),
  );
  if (input.steer) {
    await steerQueuedWebMessage(api, {
      conversationId: accepted.conversationId,
      inboundMessageId: accepted.messageId,
      viewerEmail,
    });
  }
}

/** Find or make the Lead of `viewerEmail`, as the dashboard home does. */
export async function readLeadConversationId(
  api: Hono<JuniorApiEnv>,
  viewerEmail: string,
): Promise<string> {
  const response = await api.request("/api/lead", {
    headers: { [VIEWER_HEADER]: viewerEmail },
  });
  if (response.status !== 200) {
    throw new Error(
      `Lead returned ${response.status}: ${await response.text()}`,
    );
  }
  return leadSchema.parse(await response.json()).conversationId;
}

/**
 * Answer or dismiss one Review item as the person in the Inbox does.
 * Junior tells each linked Conversation about the change.
 */
export async function actOnReviewItem(
  api: Hono<JuniorApiEnv>,
  args: {
    action: "submit" | "dismiss";
    id: string;
    values?: Record<string, string[]>;
    viewerEmail: string;
  },
): Promise<void> {
  const response = await api.request(
    `/api/review-items/${encodeURIComponent(args.id)}/actions`,
    jsonRequest(args.viewerEmail, {
      action: args.action,
      ...(args.values ? { answer: { values: args.values } } : undefined),
    }),
  );
  if (response.status !== 200) {
    throw new Error(
      `Review item action returned ${response.status}: ${await response.text()}`,
    );
  }
}
