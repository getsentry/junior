import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { lookupCanvasSection, updateCanvas } from "@/chat/slack-actions/canvases";
import { createOperationKey } from "@/chat/tools/idempotency";
import { logWarn } from "@/chat/observability";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

export function createSlackCanvasUpdateTool(state: ToolState, _context: ToolRuntimeContext) {
  return tool({
    description:
      "Update the active Slack canvas tracked in artifact context. Use when continuing or correcting a document already tracked in this thread. Do not use to create a brand-new long-form artifact.",
    inputSchema: Type.Object({
      markdown: Type.String({
        minLength: 1,
        description: "Markdown content to insert or use as replacement text."
      }),
      operation: Type.Optional(
        Type.Union(
          [Type.Literal("insert_at_end"), Type.Literal("insert_at_start"), Type.Literal("replace")],
          { description: "Canvas update mode." }
        )
      ),
      section_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional section ID required for targeted replace operations."
        })
      ),
      section_contains_text: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional helper text used to find the target section when section_id is not provided."
        })
      )
    }),
    execute: async ({ markdown, operation, section_id, section_contains_text }) => {
      const targetCanvasId = state.getTurnCreatedCanvasId() ?? state.getCurrentCanvasId();
      const resolvedOperation = operation ?? "insert_at_end";
      if (!targetCanvasId) {
        logWarn(
          "slack_canvas_update_missing_target",
          {},
          {
            "gen_ai.tool.name": "slackCanvasUpdate",
            "app.artifacts.last_canvas_id": state.artifactState.lastCanvasId ?? "none",
            "app.artifacts.turn_created_canvas_id": state.getTurnCreatedCanvasId() ?? "none"
          },
          "Canvas update rejected because no explicit target canvas was provided"
        );
        return {
          ok: false,
          error:
            "No active canvas found in artifact context"
        };
      }
      const operationKey = createOperationKey("slackCanvasUpdate", {
        canvas_id: targetCanvasId,
        markdown,
        operation: resolvedOperation,
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
        section_id ?? (section_contains_text ? await lookupCanvasSection(targetCanvasId, section_contains_text) : undefined);

      await updateCanvas({
        canvasId: targetCanvasId,
        markdown,
        operation: resolvedOperation,
        sectionId
      });
      state.patchArtifactState({ lastCanvasId: targetCanvasId });

      const response = {
        ok: true,
        canvas_id: targetCanvasId,
        operation: resolvedOperation,
        section_id: sectionId
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}
