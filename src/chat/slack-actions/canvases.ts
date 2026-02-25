import type { CanvasesSectionsLookupResponse } from "@slack/web-api";
import { getFilePermalink, getSlackClient, withSlackRetries } from "@/chat/slack-actions/client";

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

  const result = await withSlackRetries(async () => {
    if (input.channelId) {
      return client.conversations.canvases.create({
        channel_id: input.channelId,
        title: input.title,
        document_content: {
          type: "markdown",
          markdown: input.markdown
        }
      });
    }

    return client.canvases.create({
      title: input.title,
      document_content: {
        type: "markdown",
        markdown: input.markdown
      }
    });
  });

  if (!result.canvas_id) {
    throw new Error("Slack canvas was created without canvas_id");
  }

  return {
    canvasId: result.canvas_id,
    permalink: await getFilePermalink(result.canvas_id)
  };
}

export async function lookupCanvasSection(canvasId: string, containsText: string): Promise<string | undefined> {
  const client = getSlackClient();
  const response: CanvasesSectionsLookupResponse = await withSlackRetries(() =>
    client.canvases.sections.lookup({
      canvas_id: canvasId,
      criteria: {
        contains_text: containsText
      }
    })
  );

  return response.sections?.[0]?.id;
}

export async function updateCanvas(input: CanvasUpdateInput): Promise<void> {
  const client = getSlackClient();

  await withSlackRetries(() =>
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
    })
  );
}
