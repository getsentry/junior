import type { CanvasesSectionsLookupResponse } from "@slack/web-api";
import {
  getFilePermalink,
  getSlackClient,
  isCanvasChannel,
  normalizeSlackConversationId,
  withSlackRetries
} from "@/chat/slack-actions/client";

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

export async function createCanvas(input: CanvasCreateInput): Promise<{ canvasId: string; permalink?: string }> {
  const client = getSlackClient();
  const normalizedChannelId = normalizeSlackConversationId(input.channelId);
  const isConversationScoped = isCanvasChannel(normalizedChannelId);
  if (!isConversationScoped) {
    throw new Error(
      "Canvas creation requires an active Slack conversation context (C/G/D)."
    );
  }
  const channelPrefix = normalizedChannelId?.slice(0, 1) ?? "none";
  const action = "conversations.canvases.create";

  const result = await withSlackRetries(async () => {
    return client.conversations.canvases.create({
      channel_id: normalizedChannelId as string,
      title: input.title,
      document_content: {
        type: "markdown",
        markdown: input.markdown
      }
    });
  }, 3, {
    action,
    attributes: {
      "app.slack.canvas.channel_id_prefix": channelPrefix,
      "app.slack.canvas.has_channel_id": Boolean(input.channelId),
      "app.slack.canvas.title_length": input.title.length,
      "app.slack.canvas.markdown_length": input.markdown.length
    }
  });

  if (!result.canvas_id) {
    throw new Error("Slack canvas was created without canvas_id");
  }

  let permalink: string | undefined;
  try {
    permalink = await getFilePermalink(result.canvas_id);
  } catch {
    // Canvas creation succeeded; permalink lookup is best-effort.
  }

  return {
    canvasId: result.canvas_id,
    permalink
  };
}

export async function lookupCanvasSection(canvasId: string, containsText: string): Promise<string | undefined> {
  const client = getSlackClient();
  const response: CanvasesSectionsLookupResponse = await withSlackRetries(
    () =>
      client.canvases.sections.lookup({
        canvas_id: canvasId,
        criteria: {
          contains_text: containsText
        }
      }),
    3,
    {
      action: "canvases.sections.lookup",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
        "app.slack.canvas.contains_text_length": containsText.length
      }
    }
  );

  return response.sections?.[0]?.id;
}

export async function updateCanvas(input: CanvasUpdateInput): Promise<void> {
  const client = getSlackClient();

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
              markdown: input.markdown
            }
          }
        ]
      }),
    3,
    {
      action: "canvases.edit",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": input.canvasId.slice(0, 1),
        "app.slack.canvas.operation": input.operation,
        "app.slack.canvas.markdown_length": input.markdown.length
      }
    }
  );
}
