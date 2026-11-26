import { Hono } from "hono";
import { expect } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationFeedSchema,
  spaceSchema,
} from "@/api/schema";
import { getConversationStore } from "@/chat/db";
import { createConversationWorkQueueTestAdapter } from "./conversation-work";
import { signedInViewer } from "./user";

/** The work queue that the Spaces API test app uses. */
export const queue = createConversationWorkQueueTestAdapter();

/** An API app signed in as `email`, or signed out without one. */
export function apiFor(email?: string): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    if (email) context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: queue }));
  return app;
}

/** Send one API request. */
export async function request(
  app: Hono<JuniorApiEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(`http://localhost/api${path}`, {
    method,
    ...(body === undefined
      ? undefined
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

/** Send one request to the Spaces API. */
export async function send(
  app: Hono<JuniorApiEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await request(app, method, `/spaces${path}`, body);
}

/** Create a Space. */
export async function createSpace(app: Hono<JuniorApiEnv>, name: string) {
  return spaceSchema.parse(
    await (await send(app, "POST", "", { name })).json(),
  );
}

/** Start a Conversation and return its id. */
export async function startConversation(
  app: Hono<JuniorApiEnv>,
  key: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(app, "POST", "/conversations", {
    idempotencyKey: key,
    message: `Work for ${key}`,
    title: key,
    ...extra,
  });
  expect(response.status).toBe(200);
  return acceptedConversationMessageSchema.parse(await response.json())
    .conversationId;
}

/** Read one Space's list, or the viewer's own feed with no Space. */
export async function spaceFeed(
  app: Hono<JuniorApiEnv>,
  spaceId: string,
  status = "active",
) {
  const response = await request(
    app,
    "GET",
    `/conversations?${spaceId ? `spaceId=${spaceId}&` : ""}status=${status}`,
  );
  expect(response.status).toBe(200);
  return conversationFeedSchema.parse(await response.json()).conversations;
}

/** Start a Thread below a Conversation and return its id. */
export async function startThread(parentConversationId: string, id: string) {
  await getConversationStore().createChild({
    childConversationId: id,
    kind: "thread",
    parentConversationId,
  });
  return id;
}
