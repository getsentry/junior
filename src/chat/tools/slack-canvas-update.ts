import { tool } from "@/chat/tools/definition";
import { z } from "zod";
import { lookupCanvasSection, updateCanvas } from "@/chat/slack-actions/canvases";
import { createOperationKey } from "@/chat/tools/idempotency";
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
        const operationKey = createOperationKey("slack_canvas_update", {
          canvas_id: targetCanvasId,
          markdown,
          operation,
          section_id: section_id ?? null,
          section_contains_text: section_contains_text ?? null
        });
        const cached = state.getOperationResult<{
          ok: true;
          canvas_id: string;
          operation: "insert_at_end" | "insert_at_start" | "replace";
          section_id?: string;
        }>(operationKey);
        if (cached) {
          return {
            ...cached,
            deduplicated: true
          };
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

        const response = {
          ok: true,
          canvas_id: targetCanvasId,
          operation,
          section_id: sectionId
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "canvas update failed");
      }
    }
  });
}
