import type {
  CanvasesSectionsLookupResponse,
  FilesInfoResponse,
} from "@slack/web-api";
import { logWarn } from "@/chat/logging";
import {
  downloadPrivateSlackFile,
  getFilePermalink,
  getSlackClient,
  isConversationChannel,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";

export interface CanvasCreateInput {
  title: string;
  markdown: string;
  channelId?: string;
}

export interface CanvasUpdateInput {
  canvasId: string;
  markdown: string;
  operation: "insert_at_end" | "insert_at_start" | "replace";
  sectionId?: string;
}

export interface CanvasReadResult {
  canvasId: string;
  title?: string;
  permalink?: string;
  mimetype?: string;
  filetype?: string;
  content: string;
  byteLength: number;
}

/** Clamp headings deeper than h3 to h3 (Slack canvas limitation). */
export function normalizeCanvasMarkdown(markdown: string): {
  markdown: string;
  normalizedHeadingCount: number;
} {
  let normalizedHeadingCount = 0;
  const normalized = markdown
    .split("\n")
    .map((line) =>
      line.replace(/^(#{4,})(?=\s)/, () => {
        normalizedHeadingCount += 1;
        return "###";
      }),
    )
    .join("\n");

  return {
    markdown: normalized,
    normalizedHeadingCount,
  };
}

/**
 * Create a standalone Slack canvas owned by the bot and best-effort grant write
 * access to the active channel. Standalone canvases (`canvases.create`) are not
 * subject to the one-per-channel limit of `conversations.canvases.create`, so
 * the bot can produce multiple canvases in the same channel/thread.
 */
export async function createCanvas(
  input: CanvasCreateInput,
): Promise<{ canvasId: string; permalink?: string }> {
  const client = getSlackClient();
  const normalizedChannelId = normalizeSlackConversationId(input.channelId);
  const channelPrefix = normalizedChannelId?.slice(0, 1) ?? "none";
  const normalizedContent = normalizeCanvasMarkdown(input.markdown);

  const result = await withSlackRetries(
    async () => {
      return client.canvases.create({
        title: input.title,
        document_content: {
          type: "markdown",
          markdown: normalizedContent.markdown,
        },
      });
    },
    3,
    {
      action: "canvases.create",
      attributes: {
        "app.slack.canvas.channel_id_prefix": channelPrefix,
        "app.slack.canvas.has_channel_id": Boolean(input.channelId),
        "app.slack.canvas.title_length": input.title.length,
        "app.slack.canvas.markdown_length": normalizedContent.markdown.length,
        "app.slack.canvas.markdown_normalized":
          normalizedContent.normalizedHeadingCount > 0,
        "app.slack.canvas.normalized_heading_count":
          normalizedContent.normalizedHeadingCount,
      },
    },
  );

  if (!result.canvas_id) {
    throw new Error("Slack canvas was created without canvas_id");
  }

  // Grant channel members write access when we're in a regular channel. For
  // DMs the bot-owned canvas is already accessible to the DM participant via
  // the shared permalink, and `canvases.access.set` with a DM id is rejected.
  if (normalizedChannelId && isConversationChannel(normalizedChannelId)) {
    await grantChannelCanvasAccess(result.canvas_id, normalizedChannelId);
  }

  let permalink: string | undefined;
  try {
    permalink = await getFilePermalink(result.canvas_id);
  } catch {
    // Canvas creation succeeded; permalink lookup is best-effort.
  }

  return {
    canvasId: result.canvas_id,
    permalink,
  };
}

async function grantChannelCanvasAccess(
  canvasId: string,
  channelId: string,
): Promise<void> {
  const client = getSlackClient();
  try {
    await withSlackRetries(
      () =>
        client.canvases.access.set({
          canvas_id: canvasId,
          access_level: "write",
          channel_ids: [channelId],
        }),
      3,
      {
        action: "canvases.access.set",
        attributes: {
          "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
          "app.slack.canvas.channel_id_prefix": channelId.slice(0, 1),
          "app.slack.canvas.access_level": "write",
        },
      },
    );
  } catch (error) {
    logWarn(
      "slack_canvas_access_set_failed",
      {},
      {
        "app.slack.action": "canvases.access.set",
        "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
        "app.slack.canvas.channel_id_prefix": channelId.slice(0, 1),
        "app.slack.canvas.access_level": "write",
      },
      error instanceof Error
        ? error.message
        : "Failed to grant channel access to canvas",
    );
  }
}

/** Find a canvas section whose content contains the given text. */
export async function lookupCanvasSection(
  canvasId: string,
  containsText: string,
): Promise<string | undefined> {
  const client = getSlackClient();
  const response: CanvasesSectionsLookupResponse = await withSlackRetries(
    () =>
      client.canvases.sections.lookup({
        canvas_id: canvasId,
        criteria: {
          contains_text: containsText,
        },
      }),
    3,
    {
      action: "canvases.sections.lookup",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
        "app.slack.canvas.contains_text_length": containsText.length,
      },
    },
  );

  return response.sections?.[0]?.id;
}

/** Insert or replace content in an existing Slack canvas. */
export async function updateCanvas(input: CanvasUpdateInput): Promise<void> {
  const client = getSlackClient();
  const normalizedContent = normalizeCanvasMarkdown(input.markdown);

  await withSlackRetries(
    () =>
      client.canvases.edit({
        canvas_id: input.canvasId,
        changes: [
          {
            operation: input.operation,
            section_id: input.sectionId,
            document_content: {
              type: "markdown",
              markdown: normalizedContent.markdown,
            },
          },
        ],
      }),
    3,
    {
      action: "canvases.edit",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": input.canvasId.slice(0, 1),
        "app.slack.canvas.operation": input.operation,
        "app.slack.canvas.markdown_length": normalizedContent.markdown.length,
        "app.slack.canvas.markdown_normalized":
          normalizedContent.normalizedHeadingCount > 0,
        "app.slack.canvas.normalized_heading_count":
          normalizedContent.normalizedHeadingCount,
      },
    },
  );
}

const CANVAS_ID_PATTERN = /^F[A-Z0-9]+$/i;
const CANVAS_URL_FILE_ID_PATTERN =
  /\/(?:docs|canvas|files)\/(?:T[A-Z0-9]+\/)?(?:U[A-Z0-9]+\/)?(F[A-Z0-9]+)/i;

/**
 * Resolve a Slack canvas ID from a raw canvas ID or Slack docs/canvas URL.
 * Accepts forms like `F0ABCDE`, `https://team.slack.com/docs/T.../F...`, and
 * `https://team.slack.com/canvas/F...`.
 */
export function extractCanvasId(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (CANVAS_ID_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  const urlMatch = trimmed.match(CANVAS_URL_FILE_ID_PATTERN);
  if (urlMatch?.[1]) {
    return urlMatch[1].toUpperCase();
  }

  return undefined;
}

/**
 * Read a Slack canvas the bot has access to and return its raw downloadable
 * content. Slack does not expose a structured canvas-read API, so we fetch
 * file metadata via `files.info` and download the canvas body via the private
 * file URL with the bot token.
 */
export async function readCanvas(
  canvasIdOrUrl: string,
): Promise<CanvasReadResult> {
  const canvasId = extractCanvasId(canvasIdOrUrl);
  if (!canvasId) {
    throw new Error(
      "Could not parse a Slack canvas/file ID from the provided input.",
    );
  }

  const client = getSlackClient();
  const info: FilesInfoResponse = await withSlackRetries(
    () =>
      client.files.info({
        file: canvasId,
      }),
    3,
    {
      action: "files.info",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
      },
    },
  );

  const file = info.file;
  if (!file) {
    throw new Error("Slack returned no file metadata for canvas.");
  }

  const downloadUrl = file.url_private_download ?? file.url_private;
  if (!downloadUrl) {
    throw new Error(
      "Canvas has no downloadable URL; bot token may lack file access.",
    );
  }

  const buffer = await downloadPrivateSlackFile(downloadUrl);
  return {
    canvasId,
    title: file.title ?? file.name,
    permalink: file.permalink,
    mimetype: file.mimetype,
    filetype: file.filetype,
    content: buffer.toString("utf-8"),
    byteLength: buffer.byteLength,
  };
}
