import { extractCanvasId } from "@/chat/slack/tool-support/canvas/api";
import { z } from "zod";

/** Model-facing Slack canvas ID or docs URL parameter. */
export const slackCanvasRefParam = z
  .string()
  .min(1)
  .describe("Slack canvas/file ID or canvas/docs URL.");

/** Resolve model-provided canvas references before Slack API calls. */
export function resolveCanvasTarget(
  canvas: string,
): { ok: true; canvasId: string } | { ok: false; error: string } {
  const canvasId = extractCanvasId(canvas);
  if (!canvasId) {
    return {
      ok: false,
      error:
        "Could not parse a Slack canvas/file ID from input. Provide an F-prefixed ID or a Slack canvas/docs URL.",
    };
  }
  return { ok: true, canvasId };
}
