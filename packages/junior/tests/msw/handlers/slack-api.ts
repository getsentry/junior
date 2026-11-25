import { http, HttpResponse } from "msw";
import {
  SLACK_MAX_MARKDOWN_CHARS,
  SLACK_MAX_MESSAGE_BLOCKS,
  SLACK_MAX_TEXT_OBJECT_CHARS,
} from "@/chat/slack/limits";
import { TEST_USER_ID } from "../../fixtures/slack/factories/ids";
import {
  slackOk,
  authTestOk,
  botsInfoOk,
  teamInfoOk,
  canvasesAccessSetOk,
  canvasesCreateOk,
  canvasesEditOk,
  chatGetPermalinkOk,
  chatPostEphemeralOk,
  chatPostMessageOk,
  conversationsCanvasesCreateOk,
  conversationsHistoryPage,
  conversationsInfoOk,
  conversationsJoinOk,
  conversationsListPage,
  conversationsMembersPage,
  conversationsOpenOk,
  conversationsRepliesPage,
  dndInfoOk,
  filesCompleteUploadOk,
  filesGetUploadUrlOk,
  filesInfoOk,
  reactionsAddOk,
  slackError,
  slackListsCreateOk,
  slackListsItemsCreateOk,
  slackListsItemsListPage,
  slackListsItemsUpdateOk,
  usersGetPresenceOk,
  usersInfoOk,
  usersListPage,
  usersLookupByEmailOk,
} from "../../fixtures/slack/factories/api";

const EXTERNAL_UPLOAD_KEY = "__files.upload.external__";
const PRIVATE_FILE_DOWNLOAD_KEY = "__files.download.private__";

export const SUPPORTED_SLACK_API_METHODS = [
  "assistant.search.context",
  "assistant.threads.setStatus",
  "auth.test",
  "bots.info",
  "team.info",
  "assistant.threads.setSuggestedPrompts",
  "assistant.threads.setTitle",
  "chat.postMessage",
  "chat.delete",
  "chat.update",
  "chat.postEphemeral",
  "chat.getPermalink",
  "chat.unfurl",
  "views.publish",
  "views.open",
  "entity.presentDetails",
  "reactions.add",
  "reactions.remove",
  "conversations.history",
  "conversations.info",
  "conversations.join",
  "conversations.list",
  "conversations.members",
  "conversations.open",
  "conversations.replies",
  "dnd.info",
  "canvases.access.set",
  "canvases.create",
  "conversations.canvases.create",
  "canvases.edit",
  "slackLists.create",
  "slackLists.items.create",
  "slackLists.items.list",
  "slackLists.items.update",
  "files.info",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
  "users.getPresence",
  "users.info",
  "users.list",
  "users.lookupByEmail",
] as const;

export type SlackApiMethod = (typeof SUPPORTED_SLACK_API_METHODS)[number];

export interface SlackMockHttpResponse {
  status?: number;
  headers?: Record<string, string> | undefined;
  /** A stream body lets a file download arrive in chunks. */
  body?: Record<string, unknown> | string | ReadableStream<Uint8Array>;
  /** Optional artificial latency before the HTTP response is returned. */
  delayMs?: number;
  /**
   * Observe the outbound request before delay/wait. Use this to coordinate a
   * race without wall-clock guessing that delivery has started.
   */
  onRequest?: () => void;
  /**
   * Hold the HTTP response until this promise settles. Prefer this over a long
   * `delayMs` when the test must release accept at a specific production step.
   */
  waitFor?: Promise<unknown>;
}

export interface CapturedSlackApiCall {
  method: SlackApiMethod;
  url: string;
  headers: Record<string, string>;
  params: Record<string, unknown>;
}

export interface CapturedSlackFileUploadCall {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  byteLength: number;
}

export interface CapturedSlackFileDownloadCall {
  url: string;
  headers: Record<string, string>;
}

const queuedResponses = new Map<string, SlackMockHttpResponse[]>();
// Who Slack says is in each channel, for `conversations.members`.
const channelMembers = new Map<string, string[]>();
const capturedSlackApiCalls: CapturedSlackApiCall[] = [];
const capturedSlackFileUploads: CapturedSlackFileUploadCall[] = [];
const capturedSlackFileDownloads: CapturedSlackFileDownloadCall[] = [];

function isSlackApiMethod(value: string): value is SlackApiMethod {
  return (SUPPORTED_SLACK_API_METHODS as readonly string[]).includes(value);
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function maybeParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function assignBodyValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  target[key] = [existing, value];
}

async function parseSlackApiRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.text();
    const params = new URLSearchParams(body);
    const parsed: Record<string, unknown> = {};

    for (const [key, value] of params.entries()) {
      assignBodyValue(parsed, key, maybeParseJson(value));
    }

    return parsed;
  }

  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as Record<string, unknown>;
    return payload;
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const parsed: Record<string, unknown> = {};

    for (const [key, value] of form) {
      if (typeof value === "string") {
        assignBodyValue(parsed, key, value);
        continue;
      }
      assignBodyValue(parsed, key, {
        name: value.name,
        size: value.size,
        type: value.type,
      });
    }

    return parsed;
  }

  const text = await request.text();
  if (!text) {
    return {};
  }

  return { raw: text };
}

// The body that each method answers with when a test queues no response.
const DEFAULT_SLACK_API_BODIES = {
  "assistant.search.context": () => ({
    ok: true,
    results: { messages: [], next_cursor: "" },
  }),
  "assistant.threads.setStatus": () => slackOk(),
  "assistant.threads.setSuggestedPrompts": () => slackOk(),
  "assistant.threads.setTitle": () => slackOk(),
  "auth.test": () => authTestOk(),
  "team.info": () => teamInfoOk(),
  "chat.postMessage": () => chatPostMessageOk(),
  "chat.delete": () => slackOk(),
  "chat.update": () => slackOk(),
  "chat.unfurl": () => slackOk(),
  "chat.postEphemeral": () => chatPostEphemeralOk(),
  "chat.getPermalink": () => chatGetPermalinkOk(),
  "entity.presentDetails": () => slackOk(),
  "views.publish": () => slackOk(),
  "views.open": () => slackOk(),
  "reactions.add": () => reactionsAddOk(),
  "reactions.remove": () => reactionsAddOk(),
  "conversations.history": () => conversationsHistoryPage(),
  "conversations.info": () => conversationsInfoOk(),
  "conversations.join": () => conversationsJoinOk(),
  "conversations.list": () => conversationsListPage(),
  "conversations.members": (params) =>
    conversationsMembersPage({
      members: channelMembers.get(String(params["channel"])) ?? [],
    }),
  "conversations.open": () => conversationsOpenOk(),
  "conversations.replies": () => conversationsRepliesPage(),
  "dnd.info": () => dndInfoOk(),
  "canvases.access.set": () => canvasesAccessSetOk(),
  "canvases.create": () => canvasesCreateOk(),
  "conversations.canvases.create": () => conversationsCanvasesCreateOk(),
  "canvases.edit": () => canvasesEditOk(),
  "slackLists.create": () => slackListsCreateOk(),
  "slackLists.items.create": () => slackListsItemsCreateOk(),
  "slackLists.items.list": () => slackListsItemsListPage(),
  "slackLists.items.update": () => slackListsItemsUpdateOk(),
  "files.info": () => filesInfoOk(),
  "files.getUploadURLExternal": () => filesGetUploadUrlOk(),
  "files.completeUploadExternal": () => filesCompleteUploadOk(),
  "bots.info": (params) =>
    botsInfoOk({
      botId: typeof params["bot"] === "string" ? params["bot"] : undefined,
    }),
  "users.getPresence": () => usersGetPresenceOk(),
  "users.info": (params) =>
    usersInfoOk({
      userId: typeof params["user"] === "string" ? params["user"] : undefined,
    }),
  "users.list": () => usersListPage(),
  "users.lookupByEmail": () => usersLookupByEmailOk(),
} satisfies Record<
  SlackApiMethod,
  (params: Record<string, unknown>) => SlackMockHttpResponse["body"]
>;

function defaultSlackApiResponse(
  method: SlackApiMethod,
  params: Record<string, unknown>,
): SlackMockHttpResponse {
  return { body: DEFAULT_SLACK_API_BODIES[method](params) };
}

function dequeueResponse(key: string): SlackMockHttpResponse | undefined {
  const queue = queuedResponses.get(key);
  if (!queue || queue.length === 0) {
    return undefined;
  }

  const next = queue.shift();
  if (queue.length === 0) {
    queuedResponses.delete(key);
  }

  return next;
}

function toHttpResponse(response: SlackMockHttpResponse): Response {
  const status = response.status ?? 200;
  const headers = response.headers;

  if (
    typeof response.body === "string" ||
    response.body instanceof ReadableStream
  ) {
    return new HttpResponse(response.body, {
      status,
      headers,
    });
  }

  return HttpResponse.json(response.body ?? {}, {
    status,
    headers,
  });
}

function getSlackConversationParam(
  params: Record<string, unknown>,
): { key: "channel" | "channel_id"; value: string } | undefined {
  const channel = params["channel"];
  if (typeof channel === "string") {
    return { key: "channel", value: channel };
  }

  const channelId = params["channel_id"];
  if (typeof channelId === "string") {
    return { key: "channel_id", value: channelId };
  }

  return undefined;
}

const MESSAGE_BLOCK_METHODS = new Set<SlackApiMethod>([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.update",
]);

type MockBlock = {
  type?: string;
  text?: string | { text?: string };
  elements?: Array<{ text?: string }>;
};

/** Find the first way message blocks break a Slack limit, as Slack does. */
function messageBlocksError(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  if (blocks.length > SLACK_MAX_MESSAGE_BLOCKS) {
    return `must be less than ${SLACK_MAX_MESSAGE_BLOCKS + 1} items [json-pointer:/blocks]`;
  }
  let markdownChars = 0;
  for (const [index, block] of (blocks as MockBlock[]).entries()) {
    if (block.type === "markdown") {
      markdownChars += typeof block.text === "string" ? block.text.length : 0;
      continue;
    }
    const texts = [
      typeof block.text === "object" ? block.text.text : undefined,
      ...(block.type === "context"
        ? (block.elements ?? []).map((element) => element.text)
        : []),
    ];
    if (
      texts.some((text) => (text?.length ?? 0) > SLACK_MAX_TEXT_OBJECT_CHARS)
    ) {
      return `must be less than ${SLACK_MAX_TEXT_OBJECT_CHARS + 1} characters [json-pointer:/blocks/${index}]`;
    }
  }
  if (markdownChars > SLACK_MAX_MARKDOWN_CHARS) {
    return `markdown blocks must be less than ${SLACK_MAX_MARKDOWN_CHARS + 1} characters [json-pointer:/blocks]`;
  }
  return undefined;
}

function validateSlackApiRequest(
  method: SlackApiMethod,
  params: Record<string, unknown>,
): SlackMockHttpResponse | undefined {
  const conversation = getSlackConversationParam(params);
  if (conversation?.value.startsWith("slack:")) {
    return {
      body: slackError({
        error: "channel_not_found",
        detail: `Invalid ${conversation.key}`,
      }),
    };
  }

  const blocksError = MESSAGE_BLOCK_METHODS.has(method)
    ? messageBlocksError(params["blocks"])
    : undefined;
  if (blocksError) {
    return {
      body: slackError({
        error: "invalid_blocks",
        response_metadata: { messages: [`[ERROR] ${blocksError}`] },
      }),
    };
  }

  return undefined;
}

export function queueSlackApiResponse(
  method: SlackApiMethod,
  response: SlackMockHttpResponse,
): void {
  const queue = queuedResponses.get(method) ?? [];
  queue.push(response);
  queuedResponses.set(method, queue);
}

/** Set who Slack says is in a channel, DM, or group DM now. */
export function setSlackChannelMembers(
  channelId: string,
  members: readonly string[],
): void {
  channelMembers.set(channelId, [...members]);
}

/** Add a person to who Slack says is in a channel, DM, or group DM now. */
export function addSlackChannelMember(channelId: string, member: string): void {
  channelMembers.set(channelId, [
    ...(channelMembers.get(channelId) ?? []),
    member,
  ]);
}

export function queueSlackApiError(
  method: SlackApiMethod,
  input: {
    error: string;
    needed?: string;
    provided?: string;
    status?: number;
    headers?: Record<string, string>;
  },
): void {
  queueSlackApiResponse(method, {
    status: input.status ?? 200,
    headers: input.headers,
    body: slackError({
      error: input.error,
      ...(input.needed ? { needed: input.needed } : undefined),
      ...(input.provided ? { provided: input.provided } : undefined),
    }),
  });
}

export function queueSlackRateLimit(
  method: SlackApiMethod,
  retryAfterSeconds = 1,
  body: Record<string, unknown> | string = "rate limited",
): void {
  queueSlackApiResponse(method, {
    status: 429,
    headers: {
      "retry-after": String(retryAfterSeconds),
    },
    body,
  });
}

export function queueSlackExternalUploadResponse(
  response: SlackMockHttpResponse,
): void {
  const queue = queuedResponses.get(EXTERNAL_UPLOAD_KEY) ?? [];
  queue.push(response);
  queuedResponses.set(EXTERNAL_UPLOAD_KEY, queue);
}

export function queueSlackPrivateFileDownload(
  response: SlackMockHttpResponse,
): void {
  const queue = queuedResponses.get(PRIVATE_FILE_DOWNLOAD_KEY) ?? [];
  queue.push(response);
  queuedResponses.set(PRIVATE_FILE_DOWNLOAD_KEY, queue);
}

export function getCapturedSlackApiCalls(
  method?: SlackApiMethod,
): CapturedSlackApiCall[] {
  if (!method) {
    return [...capturedSlackApiCalls];
  }
  return capturedSlackApiCalls.filter((entry) => entry.method === method);
}

export function getCapturedSlackFileUploadCalls(): CapturedSlackFileUploadCall[] {
  return [...capturedSlackFileUploads];
}

export function getCapturedSlackFileDownloadCalls(): CapturedSlackFileDownloadCall[] {
  return [...capturedSlackFileDownloads];
}

export function resetSlackApiMockState(): void {
  queuedResponses.clear();
  channelMembers.clear();
  capturedSlackApiCalls.length = 0;
  capturedSlackFileUploads.length = 0;
  capturedSlackFileDownloads.length = 0;
}

export const slackApiHandlers = [
  http.post("https://slack.com/api/:method", async ({ params, request }) => {
    const rawMethod = params["method"];
    if (typeof rawMethod !== "string" || !isSlackApiMethod(rawMethod)) {
      throw new Error(
        `[MSW] Unsupported Slack API method: ${String(rawMethod ?? "unknown")}`,
      );
    }

    const requestBody = await parseSlackApiRequestBody(request);
    capturedSlackApiCalls.push({
      method: rawMethod,
      url: request.url,
      headers: normalizeHeaders(request.headers),
      params: requestBody,
    });

    const validationResponse = validateSlackApiRequest(rawMethod, requestBody);
    if (validationResponse) {
      return toHttpResponse(validationResponse);
    }

    const response =
      dequeueResponse(rawMethod) ??
      defaultSlackApiResponse(rawMethod, requestBody);
    response.onRequest?.();
    if (response.waitFor) {
      await response.waitFor;
    }
    if (response.delayMs !== undefined && response.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    return toHttpResponse(response);
  }),

  http.get("https://slack.com/api/users.info", async ({ request }) => {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user") ?? "U0TEST";

    capturedSlackApiCalls.push({
      method: "users.info",
      url: request.url,
      headers: normalizeHeaders(request.headers),
      params: {
        user: userId,
      },
    });

    const email =
      userId === TEST_USER_ID
        ? undefined
        : `${userId.toLowerCase()}@example.com`;
    const response = dequeueResponse("users.info") ?? {
      body: usersInfoOk({ userId, email }),
    };

    return toHttpResponse(response);
  }),

  http.post("https://files.slack.com/upload/:path*", async ({ request }) => {
    const buffer = await request.arrayBuffer();

    capturedSlackFileUploads.push({
      method: "POST",
      url: request.url,
      headers: normalizeHeaders(request.headers),
      byteLength: buffer.byteLength,
    });

    const response = dequeueResponse(EXTERNAL_UPLOAD_KEY) ?? {
      status: 200,
      body: "ok",
    };

    return toHttpResponse(response);
  }),

  http.get("https://files.slack.com/:path*", async ({ request }) => {
    capturedSlackFileDownloads.push({
      url: request.url,
      headers: normalizeHeaders(request.headers),
    });
    const response = dequeueResponse(PRIVATE_FILE_DOWNLOAD_KEY) ?? {
      status: 200,
      body: "",
    };
    return toHttpResponse(response);
  }),
];
