/**
 * Slack mock for the agent test fixture.
 *
 * Shared MSW handlers mock the Slack Web API. This module adds the parts a
 * Conversation needs: the bot identity, unique reply timestamps, thread
 * history for `conversations.replies`, and profiles for `users.info`. It also
 * signs Events API webhooks for the app route.
 */
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { getSlackSigningSecret } from "@/chat/config";
import { mswServer } from "@junior-tests/msw/server";
import {
  authTestOk,
  chatPostMessageOk,
  conversationsRepliesPage,
  usersInfoOk,
} from "@junior-tests/fixtures/slack/factories/api";
import {
  TEST_BOT_USER_ID,
  TEST_USER_ID,
} from "@junior-tests/fixtures/slack/factories/ids";
import type { SlackAuthor } from "./inputs";

export const SLACK_TEAM_ID = "TEVAL";
export const SLACK_BOT_USER_ID = TEST_BOT_USER_ID;
export const DEFAULT_SLACK_AUTHOR = {
  fullName: "Test User",
  userId: TEST_USER_ID,
  userName: "testuser",
} as const satisfies Required<SlackAuthor>;

/** One message in a Slack thread, as `conversations.replies` returns it. */
type SlackThreadMessage = {
  bot_id?: string;
  text: string;
  thread_ts: string;
  ts: string;
  user: string;
};

/** An app that answers HTTP requests, such as the one `createApp()` returns. */
export interface RequestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** A thread reply that Junior posted through `chat.postMessage`. */
export interface SlackPost {
  channel: string;
  text: string;
  threadTs?: string;
  ts: string;
}

export interface SlackMock {
  /** Add a message that people or Junior posted before the input. */
  addThreadMessage(
    channel: string,
    message: Omit<SlackThreadMessage, "ts"> & { ts?: string },
  ): string;
  newChannelId(channelType: "channel" | "im"): string;
  nextTs(): string;
  posts(): SlackPost[];
  registerAuthor(author: SlackAuthor): Required<SlackAuthor>;
  /** Called before the mock answers each `chat.postMessage`. */
  setReplyHook(hook: ((post: SlackPost) => Promise<void>) | undefined): void;
}

async function readSlackParams(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

/** The email `users.info` returns, which links the Slack person to Junior. */
export function slackAuthorEmail(author: Required<SlackAuthor>): string {
  return `${author.userName}@example.com`;
}

/** Install the fixture Slack handlers for the current test. */
export function installSlackMock(): SlackMock {
  let tsSequence = 0;
  let channelSequence = 0;
  const baseSeconds = Math.floor(Date.now() / 1000);
  const threads = new Map<string, SlackThreadMessage[]>();
  const authors = new Map<string, Required<SlackAuthor>>([
    [DEFAULT_SLACK_AUTHOR.userId, DEFAULT_SLACK_AUTHOR],
  ]);
  const posts: SlackPost[] = [];
  let replyHook: ((post: SlackPost) => Promise<void>) | undefined;

  const nextTs = () => {
    tsSequence += 1;
    return `${baseSeconds}.${String(tsSequence).padStart(6, "0")}`;
  };
  const threadKey = (channel: string, threadTs: string) =>
    `${channel}:${threadTs}`;
  const addThreadMessage: SlackMock["addThreadMessage"] = (
    channel,
    message,
  ) => {
    const ts = message.ts ?? nextTs();
    const key = threadKey(channel, message.thread_ts);
    const messages = threads.get(key) ?? [];
    messages.push({ ...message, ts });
    threads.set(key, messages);
    return ts;
  };

  const usersInfo = (userId: string | null) => {
    const author = userId ? authors.get(userId) : undefined;
    if (!author) return undefined;
    const body = usersInfoOk({
      displayName: author.fullName,
      realName: author.fullName,
      userId: author.userId,
      userName: author.userName,
      email: slackAuthorEmail(author),
    });
    // Ingress accepts authors from the receiving workspace only.
    return HttpResponse.json({
      ...body,
      user: { ...body.user, team_id: SLACK_TEAM_ID },
    });
  };

  mswServer.use(
    http.post("https://slack.com/api/auth.test", () =>
      HttpResponse.json(
        authTestOk({ teamId: SLACK_TEAM_ID, userId: SLACK_BOT_USER_ID }),
      ),
    ),
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      const params = await readSlackParams(request);
      const channel = params.channel ?? "";
      const post: SlackPost = {
        channel,
        text: params.text ?? "",
        ts: nextTs(),
        ...(params.thread_ts ? { threadTs: params.thread_ts } : undefined),
      };
      posts.push(post);
      if (post.threadTs) {
        addThreadMessage(channel, {
          bot_id: "B_TEST_BOT",
          text: post.text,
          thread_ts: post.threadTs,
          ts: post.ts,
          user: SLACK_BOT_USER_ID,
        });
      }
      await replyHook?.(post);
      return HttpResponse.json(chatPostMessageOk({ channel, ts: post.ts }));
    }),
    http.post(
      "https://slack.com/api/conversations.replies",
      async ({ request }) => {
        const params = await readSlackParams(request);
        const threadTs = params.ts ?? "";
        return HttpResponse.json(
          conversationsRepliesPage({
            messages: threads.get(threadKey(params.channel ?? "", threadTs)),
            threadTs,
          }),
        );
      },
    ),
    http.get("https://slack.com/api/users.info", ({ request }) =>
      usersInfo(new URL(request.url).searchParams.get("user")),
    ),
    http.post("https://slack.com/api/users.info", async ({ request }) =>
      usersInfo((await readSlackParams(request)).user ?? null),
    ),
  );

  return {
    addThreadMessage,
    newChannelId(channelType) {
      channelSequence += 1;
      const suffix = `${baseSeconds.toString(36)}${channelSequence}`;
      return `${channelType === "im" ? "D" : "C"}EVAL${suffix.toUpperCase()}`;
    },
    nextTs,
    posts: () => [...posts],
    registerAuthor(author) {
      const userId = author.userId ?? DEFAULT_SLACK_AUTHOR.userId;
      const known = authors.get(userId);
      const resolved = {
        fullName: author.fullName ?? known?.fullName ?? userId,
        userId,
        userName: author.userName ?? known?.userName ?? userId.toLowerCase(),
      };
      authors.set(userId, resolved);
      return resolved;
    },
    setReplyHook(hook) {
      replyHook = hook;
    },
  };
}

let eventSequence = 0;

/** Post one signed Slack Events API message event to the app route. */
export async function postSlackMessageEvent(
  app: RequestApp,
  event: {
    channel: string;
    channelType: "channel" | "im";
    mention: boolean;
    text: string;
    threadTs?: string;
    ts: string;
    user: string;
  },
): Promise<void> {
  eventSequence += 1;
  const body = JSON.stringify({
    token: "test-token",
    team_id: SLACK_TEAM_ID,
    api_app_id: "A_EVAL",
    type: "event_callback",
    event_id: `EvEVAL${eventSequence}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: event.mention ? "app_mention" : "message",
      user: event.user,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      event_ts: event.ts,
      ...(event.threadTs ? { thread_ts: event.threadTs } : undefined),
      ...(event.mention ? undefined : { channel_type: event.channelType }),
    },
  });
  const secret = getSlackSigningSecret();
  if (!secret) {
    throw new Error("The agent test fixture needs SLACK_SIGNING_SECRET");
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const response = await app.request("/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
  if (response.status !== 200) {
    throw new Error(
      `Slack webhook returned ${response.status}: ${await response.text()}`,
    );
  }
}
