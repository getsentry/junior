/**
 * Requests that the fixture sends to the dashboard API as a signed-in person.
 */
import type { Hono } from "hono";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  steerConversationPendingMessagesResponseSchema,
} from "@/api/schema";
import type { FileInput } from "./inputs";
import { VIEWER_HEADER } from "./results";

/** An image as the dashboard sends it with a message. */
export function webImage(image: FileInput) {
  if (!image.content) throw new Error(`Image ${image.name} needs content`);
  return {
    contentType: image.mimeType,
    data: image.content.toString("base64"),
    filename: image.name,
  };
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
export async function expectAccepted(response: Response) {
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
export async function steerQueuedWebMessage(
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
