import { tool } from "ai";
import { z } from "zod";
import { lookupCanvasSection, updateCanvas } from "@/chat/slack-actions/canvases";
import type { ToolState } from "@/chat/tools/types";

export function createSlackCanvasUpdateTool(state: ToolState) {
  return tool({
    description: "Update a Slack canvas using insert or replace operations.",
    inputSchema: z.object({
      canvas_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional canvas ID. Defaults to the last canvas used in this thread."),
      markdown: z
        .string()
        .min(1)
        .describe("Markdown content to insert or use as replacement text."),
      operation: z
        .enum(["insert_at_end", "insert_at_start", "replace"])
        .default("insert_at_end")
        .describe("Canvas update mode."),
      section_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional section ID required for targeted replace operations."),
      section_contains_text: z
        .string()
        .min(1)
        .optional()
        .describe("Optional helper text used to find the target section when section_id is not provided.")
    }),
    execute: async ({ canvas_id, markdown, operation, section_id, section_contains_text }) => {
      try {
        const targetCanvasId = canvas_id ?? state.getCurrentCanvasId();
        if (!targetCanvasId) {
          return { ok: false, error: "No canvas_id provided and no prior canvas found in thread state" };
        }

        const sectionId =
          section_id ??
          (section_contains_text ? await lookupCanvasSection(targetCanvasId, section_contains_text) : undefined);

        await updateCanvas({
          canvasId: targetCanvasId,
          markdown,
          operation,
          sectionId
        });
        state.patchArtifactState({ lastCanvasId: targetCanvasId });

        return {
          ok: true,
          canvas_id: targetCanvasId,
          operation,
          section_id: sectionId
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "canvas update failed"
        };
      }
    }
  });
}
