/**
 * Requests that the fixture sends to the dashboard API as a signed-in person.
 */
import type { Hono } from "hono";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  attachmentUploadSchema,
  leadSchema,
  spaceSchema,
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
/**
 * Send one message as the dashboard composer does: upload its files and
 * post it. With no `conversationId`, the post creates the Conversation.
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
  await expectAccepted(
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
}

/**
 * Create a Space as `viewerEmail` and make its Lead, as the Space page does
 * when a member opens it.
 */
export async function readLeadConversationId(
  api: Hono<JuniorApiEnv>,
  viewerEmail: string,
): Promise<string> {
  const created = await api.request(
    "/api/spaces",
    jsonRequest(viewerEmail, { name: "Eval work" }),
  );
  if (created.status !== 201) {
    throw new Error(
      `Space create returned ${created.status}: ${await created.text()}`,
    );
  }
  const space = spaceSchema.parse(await created.json());
  const response = await api.request(
    `/api/spaces/${encodeURIComponent(space.id)}/lead`,
    { headers: { [VIEWER_HEADER]: viewerEmail } },
  );
  if (response.status !== 200) {
    throw new Error(
      `Lead returned ${response.status}: ${await response.text()}`,
    );
  }
  return leadSchema.parse(await response.json()).conversationId;
}

/**
 * Answer or dismiss one Inbox item as the person in the Inbox does.
 * Junior tells each linked Conversation about the change.
 */
export async function actOnInboxItem(
  api: Hono<JuniorApiEnv>,
  args: {
    action: "submit" | "dismiss";
    id: string;
    values?: Record<string, string[]>;
    viewerEmail: string;
  },
): Promise<void> {
  const response = await api.request(
    `/api/inbox-items/${encodeURIComponent(args.id)}/actions`,
    jsonRequest(args.viewerEmail, {
      action: args.action,
      ...(args.values ? { answer: { values: args.values } } : undefined),
    }),
  );
  if (response.status !== 200) {
    throw new Error(
      `Inbox item action returned ${response.status}: ${await response.text()}`,
    );
  }
}
