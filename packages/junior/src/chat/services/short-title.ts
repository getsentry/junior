import { botConfig } from "@/chat/config";
import type { completeText } from "@/chat/pi/client";
import { logWarn } from "@/chat/logging";

export const SHORT_TITLE_MAX_LENGTH = 60;

export type ShortTitleKind = "conversation" | "task";

const TITLE_PROMPTS: Record<ShortTitleKind, string[]> = {
  conversation: [
    "Generate a concise 5-8 word Slack conversation title from the first user message below.",
    "Capture the user's main request.",
    "Reply with ONLY the title, with no quotes or trailing punctuation.",
  ],
  task: [
    "Generate a concise 5-8 word task title from the task instruction below.",
    "Capture the task's main purpose.",
    "Reply with ONLY the title, with no quotes or trailing punctuation.",
  ],
};

/** Collapse whitespace and cap a candidate short title. */
export function normalizeShortTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SHORT_TITLE_MAX_LENGTH);
}

/**
 * Deterministic display title when no generated title is stored.
 * Uses the first non-empty line of the source text, capped like generated titles.
 */
export function fallbackShortTitle(
  sourceText: string,
  fallback = "Untitled",
): string {
  const firstLine =
    sourceText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return normalizeShortTitle(firstLine) || fallback;
}

/** Generate a short title with the fast model, or return undefined on failure. */
export async function generateShortTitle(args: {
  completeText: typeof completeText;
  kind: ShortTitleKind;
  sourceText: string;
}): Promise<string | undefined> {
  const sourceText = args.sourceText.trim();
  if (!sourceText) return undefined;

  try {
    const result = await args.completeText({
      modelId: botConfig.fastModelId,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            ...TITLE_PROMPTS[args.kind],
            "",
            args.kind === "conversation"
              ? `First user message: ${sourceText.slice(0, 500)}`
              : `Task instruction: ${sourceText.slice(0, 500)}`,
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
      metadata: {
        modelId: botConfig.fastModelId,
      },
    });
    const title = normalizeShortTitle(result.text);
    return title || undefined;
  } catch (error) {
    logWarn(`${args.kind}.title.generation.failed`, {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
