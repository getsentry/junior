import { http, HttpResponse } from "msw";
import {
  slackOk,
  canvasesCreateOk,
  canvasesEditOk,
  canvasesSectionsLookupOk,
  chatGetPermalinkOk,
  chatPostEphemeralOk,
  chatPostMessageOk,
  conversationsCanvasesCreateOk,
  conversationsHistoryPage,
  conversationsRepliesPage,
  filesCompleteUploadOk,
  filesGetUploadUrlOk,
  filesInfoOk,
  reactionsAddOk,
  slackError,
  slackListsCreateOk,
  slackListsItemsCreateOk,
  slackListsItemsListPage,
  slackListsItemsUpdateOk,
  usersInfoOk,
} from "../../fixtures/slack/factories/api";

const EXTERNAL_UPLOAD_KEY = "__files.upload.external__";

export const SUPPORTED_SLACK_API_METHODS = [
  "assistant.threads.setStatus",
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.getPermalink",
  "views.publish",
  "reactions.add",
  "reactions.remove",
  "conversations.history",
  "conversations.replies",
  "canvases.create",
  "conversations.canvases.create",
  "canvases.sections.lookup",
  "canvases.edit",
  "slackLists.create",
  "slackLists.items.create",
  "slackLists.items.list",
  "slackLists.items.update",
  "files.info",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
  "users.info",
] as const;

export type SlackApiMethod = (typeof SUPPORTED_SLACK_API_METHODS)[number];

export interface SlackMockHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
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

const queuedResponses = new Map<string, SlackMockHttpResponse[]>();
const capturedSlackApiCalls: CapturedSlackApiCall[] = [];
const capturedSlackFileUploads: CapturedSlackFileUploadCall[] = [];

function isSlackApiMethod(value: string): value is SlackApiMethod {
  return (SUPPORTED_SLACK_API_METHODS as readonly string[]).includes(value);
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
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

    form.forEach((value, key) => {
      if (typeof value === "string") {
        assignBodyValue(parsed, key, value);
        return;
      }
      assignBodyValue(parsed, key, {
        name: value.name,
        size: value.size,
        type: value.type,
      });
    });

    return parsed;
  }

  const text = await request.text();
  if (!text) {
    return {};
  }

  return { raw: text };
}

function defaultSlackApiResponse(
  method: SlackApiMethod,
): SlackMockHttpResponse {
  switch (method) {
    case "assistant.threads.setStatus":
      return { body: slackOk() };
    case "chat.postMessage":
      return { body: chatPostMessageOk() };
    case "chat.postEphemeral":
      return { body: chatPostEphemeralOk() };
    case "chat.getPermalink":
      return { body: chatGetPermalinkOk() };
    case "views.publish":
      return { body: slackOk() };
    case "reactions.add":
      return { body: reactionsAddOk() };
    case "reactions.remove":
      return { body: reactionsAddOk() };
    case "conversations.history":
      return { body: conversationsHistoryPage() };
    case "conversations.replies":
      return { body: conversationsRepliesPage() };
    case "canvases.create":
      return { body: canvasesCreateOk() };
    case "conversations.canvases.create":
      return { body: conversationsCanvasesCreateOk() };
    case "canvases.sections.lookup":
      return { body: canvasesSectionsLookupOk() };
    case "canvases.edit":
      return { body: canvasesEditOk() };
    case "slackLists.create":
      return { body: slackListsCreateOk() };
    case "slackLists.items.create":
      return { body: slackListsItemsCreateOk() };
    case "slackLists.items.list":
      return { body: slackListsItemsListPage() };
    case "slackLists.items.update":
      return { body: slackListsItemsUpdateOk() };
    case "files.info":
      return { body: filesInfoOk() };
    case "files.getUploadURLExternal":
      return { body: filesGetUploadUrlOk() };
    case "files.completeUploadExternal":
      return { body: filesCompleteUploadOk() };
    case "users.info":
      return { body: usersInfoOk() };
    default:
      return {
        status: 400,
        body: slackError({
          error: "invalid_arguments",
          provided: method,
        }),
      };
  }
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

  if (typeof response.body === "string") {
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

export function queueSlackApiResponse(
  method: SlackApiMethod,
  response: SlackMockHttpResponse,
): void {
  const queue = queuedResponses.get(method) ?? [];
  queue.push(response);
  queuedResponses.set(method, queue);
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
      ...(input.needed ? { needed: input.needed } : {}),
      ...(input.provided ? { provided: input.provided } : {}),
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

export function resetSlackApiMockState(): void {
  queuedResponses.clear();
  capturedSlackApiCalls.length = 0;
  capturedSlackFileUploads.length = 0;
}

export const slackApiHandlers = [
  http.post("https://slack.com/api/:method", async ({ params, request }) => {
    const rawMethod = params.method;
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

    const response =
      dequeueResponse(rawMethod) ?? defaultSlackApiResponse(rawMethod);
    return toHttpResponse(response);
  }),

  http.get("https://slack.com/api/users.info", async ({ request }) => {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user") ?? "U_TEST";

    capturedSlackApiCalls.push({
      method: "users.info",
      url: request.url,
      headers: normalizeHeaders(request.headers),
      params: {
        user: userId,
      },
    });

    const response = dequeueResponse("users.info") ?? {
      body: usersInfoOk({ userId }),
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
];
