/**
 * Slack mock for the agent test fixture.
 *
 * Shared MSW handlers mock the Slack Web API. This module adds the parts a
 * Conversation needs: the bot identity, unique reply timestamps, thread
 * history for `conversations.replies`, and profiles for `users.info`. It also
 * signs Events API webhooks for the app route.
 */
import { createHash, createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { getSlackSigningSecret } from "@/chat/config";
import { mswServer } from "@junior-tests/msw/server";
import {
  authTestOk,
  chatPostEphemeralOk,
  chatPostMessageOk,
  conversationsRepliesPage,
  usersInfoOk,
} from "@junior-tests/fixtures/slack/factories/api";
import {
  TEST_BOT_USER_ID,
  TEST_USER_ID,
} from "@junior-tests/fixtures/slack/factories/ids";
import type { FileInput, SlackAuthor } from "./inputs";

export const SLACK_TEAM_ID = "TEVAL";
export const SLACK_BOT_USER_ID = TEST_BOT_USER_ID;
export const DEFAULT_SLACK_AUTHOR = {
  fullName: "Test User",
  userId: TEST_USER_ID,
  userName: "testuser",
} as const satisfies Required<SlackAuthor>;

/** An uploaded file, as Slack describes it in events and thread history. */
export type SlackFile = {
  id: string;
  mimetype: string;
  name: string;
  size: number;
  url_private: string;
  url_private_download: string;
};

/** One message in a Slack thread, as `conversations.replies` returns it. */
type SlackThreadMessage = {
  bot_id?: string;
  files?: SlackFile[];
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
  /** Add a file that a person uploaded. The mock serves its download. */
  addFile(file: FileInput): SlackFile;
  /**
   * Authorization links that a person saw in private, oldest first: the
   * ephemeral messages to the person, and the messages in their direct
   * message channel. A link in another channel is not private.
   */
  authorizationLinks(person: {
    directMessageChannel?: string;
    userId: string;
  }): string[];
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

/**
 * The message body people see. Slack shows `blocks` instead of `text`, which
 * is a notification fallback that can repeat the footer.
 */
function readPostBody(params: Record<string, string>): string {
  const blocks = params.blocks
    ? (JSON.parse(params.blocks) as Array<{
        text?: string | { text?: string };
        type?: string;
      }>)
    : [];
  const body = blocks
    .flatMap((block) =>
      block.type === "markdown" && typeof block.text === "string"
        ? [block.text]
        : block.type === "section" && typeof block.text === "object"
          ? [block.text.text ?? ""]
          : [],
    )
    .filter(Boolean)
    .join("\n\n");
  return body || (params.text ?? "");
}

/** The URL of the Connect button in an authorization message. */
function readAuthorizationUrl(
  params: Record<string, string>,
): string | undefined {
  const blocks = params.blocks
    ? (JSON.parse(params.blocks) as Array<{
        accessory?: { action_id?: string; url?: string };
      }>)
    : [];
  return blocks.find((block) => block.accessory?.action_id === "oauth_connect")
    ?.accessory?.url;
}

/** The email `users.info` returns, which links the Slack person to Junior. */
export function slackAuthorEmail(author: Required<SlackAuthor>): string {
  return `${author.userName}@example.com`;
}

/** The earliest second of a fixture Slack timestamp, in May 2026. */
const SLACK_TS_EPOCH_SECONDS = 1_780_000_000;

/**
 * The first second of the Slack timestamps of a test. It comes from the test
 * name, so a test has the same timestamps, channels, and Conversation ids on
 * each run, and model replay sees the same requests. Different tests get
 * different seconds, so they do not share threads in shared state.
 */
function slackBaseSeconds(testName: string): number {
  const hash = createHash("sha256").update(testName).digest();
  return SLACK_TS_EPOCH_SECONDS + (hash.readUInt32BE(0) % 10_000_000);
}

/**
 * Install the fixture Slack handlers for the current test. `testName` makes
 * the timestamps and channel ids of the test the same on each run.
 */
export function installSlackMock(testName: string): SlackMock {
  let tsSequence = 0;
  let channelSequence = 0;
  const baseSeconds = slackBaseSeconds(testName);
  const threads = new Map<string, SlackThreadMessage[]>();
  const authors = new Map<string, Required<SlackAuthor>>([
    [DEFAULT_SLACK_AUTHOR.userId, DEFAULT_SLACK_AUTHOR],
  ]);
  const posts: SlackPost[] = [];
  // An ephemeral message has the person who saw it.
  const authorizationLinks: Array<{
    channel: string;
    url: string;
    userId?: string;
  }> = [];
  let replyHook: ((post: SlackPost) => Promise<void>) | undefined;
  const files = new Map<string, FileInput>();

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
        text: readPostBody(params),
        ts: nextTs(),
        ...(params.thread_ts ? { threadTs: params.thread_ts } : undefined),
      };
      posts.push(post);
      const authorizationUrl = readAuthorizationUrl(params);
      if (authorizationUrl) {
        authorizationLinks.push({ channel, url: authorizationUrl });
      }
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
      "https://slack.com/api/chat.postEphemeral",
      async ({ request }) => {
        const params = await readSlackParams(request);
        const url = readAuthorizationUrl(params);
        if (url) {
          authorizationLinks.push({
            channel: params.channel ?? "",
            url,
            userId: params.user ?? "",
          });
        }
        return HttpResponse.json(chatPostEphemeralOk());
      },
    ),
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
    http.get(
      "https://files.slack.com/files-pri/:fileKey/:name",
      ({ params }) => {
        const file = files.get(String(params.fileKey));
        if (!file?.content) {
          return HttpResponse.json(
            { error: "file_not_found" },
            { status: 404 },
          );
        }
        return new HttpResponse(new Uint8Array(file.content), {
          headers: { "content-type": file.mimeType },
        });
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
    authorizationLinks: (person) =>
      authorizationLinks
        .filter((link) =>
          link.userId === undefined
            ? link.channel === person.directMessageChannel
            : link.userId === person.userId,
        )
        .map((link) => link.url),
    addFile(file) {
      const id = `F${String(files.size + 1).padStart(8, "0")}`;
      const fileKey = `${SLACK_TEAM_ID}-${id}`;
      files.set(fileKey, file);
      const url = `https://files.slack.com/files-pri/${fileKey}/${encodeURIComponent(file.name)}`;
      return {
        id,
        mimetype: file.mimeType,
        name: file.name,
        size: file.content?.byteLength ?? 0,
        url_private: url,
        url_private_download: url,
      };
    },
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

/**
 * Whether Slack delivers an input as `app_mention`. Direct messages arrive as
 * `message` events with `channel_type: "im"`, even when they name Junior.
 */
export function isAppMention(
  input: { kind: string },
  channelType: "channel" | "im",
): boolean {
  return input.kind === "mention" && channelType !== "im";
}

let eventSequence = 0;

/**
 * Deliver one Slack message to the app route as Slack does. A channel mention
 * arrives as two signed events with the same `ts`: a `message` event, which
 * has the channel type, and an `app_mention` event, which has none. Slack does
 * not fix their order, and Junior stores the first one. The fixture sends
 * `app_mention` first, so each mention turn must learn the channel type from
 * Slack and not from the event. Both events have the uploaded files, and the
 * `message` event has the `file_share` subtype.
 */
export async function postSlackMessageEvent(
  app: RequestApp,
  event: {
    channel: string;
    channelType: "channel" | "im";
    files?: SlackFile[];
    mention: boolean;
    text: string;
    threadTs?: string;
    ts: string;
    user: string;
  },
): Promise<void> {
  const message = {
    user: event.user,
    text: event.text,
    channel: event.channel,
    ts: event.ts,
    event_ts: event.ts,
    ...(event.threadTs ? { thread_ts: event.threadTs } : undefined),
    ...(event.files ? { files: event.files } : undefined),
  };
  if (event.mention) {
    await postSlackEvent(app, { ...message, type: "app_mention" });
  }
  await postSlackEvent(app, {
    ...message,
    type: "message",
    channel_type: event.channelType,
    ...(event.files ? { subtype: "file_share" } : undefined),
  });
}

/** Post one signed Slack Events API event to the app route. */
async function postSlackEvent(
  app: RequestApp,
  event: Record<string, unknown>,
): Promise<void> {
  eventSequence += 1;
  const body = JSON.stringify({
    token: "test-token",
    team_id: SLACK_TEAM_ID,
    api_app_id: "A_EVAL",
    type: "event_callback",
    event_id: `EvEVAL${eventSequence}`,
    event_time: Math.floor(Date.now() / 1000),
    event,
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
