import type { CanvasArtifactSummary } from "@/chat/state/artifacts";
import { extractCanvasId } from "@/chat/slack/tools/canvas/api";
import type { ToolState } from "@/chat/tools/types";

const MAX_RECENT_CANVASES = 5;

/** Merge a created canvas into artifact state without growing context forever. */
export function mergeRecentCanvases(
  existing: CanvasArtifactSummary[] | undefined,
  created: { id: string; title: string; url?: string },
): CanvasArtifactSummary[] {
  const nextEntry: CanvasArtifactSummary = {
    id: created.id,
    title: created.title,
    url: created.url,
    createdAt: new Date().toISOString(),
  };
  const prior = existing ?? [];
  const deduped = prior.filter((entry) => entry.id !== created.id);
  return [nextEntry, ...deduped].slice(0, MAX_RECENT_CANVASES);
}

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

/** Preserve known canvas permalinks when tools only receive an ID. */
export function storedCanvasUrl(
  state: ToolState,
  canvasId: string,
): string | undefined {
  const lastCanvasUrl = state.artifactState.lastCanvasUrl;
  if (lastCanvasUrl && extractCanvasId(lastCanvasUrl) === canvasId) {
    return lastCanvasUrl;
  }
  for (const canvas of state.artifactState.recentCanvases ?? []) {
    if (extractCanvasId(canvas.id) === canvasId) {
      return canvas.url;
    }
    if (canvas.url && extractCanvasId(canvas.url) === canvasId) {
      return canvas.url;
    }
  }
  return undefined;
}
