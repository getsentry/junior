import type { PiMessage } from "@/chat/pi/messages";
import { latestTurnContextSection } from "@/chat/pi/transcript";
import { PLAN_DELTA_TAG } from "@/chat/plan/prompt";
import {
  CAPABILITY_SECTION_TAG,
  REQUEST_CONTEXT_SECTION_TAG,
  SCRIPT_TOOLS_SECTION_TAG,
} from "@/chat/turn-context-tag";

// Which Turn context sections compaction keeps, drops, or keeps only as the
// latest copy.

/** Remove every copy of the given Turn context sections from one text. */
export function withoutSections(text: string, tags: string[]): string {
  return tags.reduce(
    (result, tag) =>
      result.replace(
        new RegExp(
          `\\n\\n<${tag}(?: [^>\\n]*)?>\\n[\\s\\S]*?\\n</${tag}>`,
          "g",
        ),
        "",
      ),
    text,
  );
}

/**
 * Remove the sections that only the Turn that received them can use, and
 * plan deltas, which the `<plan>` snapshot of the summary replaces.
 */
export function withoutRequestContext(text: string): string {
  return withoutSections(text, [
    ...Object.values(REQUEST_CONTEXT_SECTION_TAG),
    PLAN_DELTA_TAG,
  ]);
}

/**
 * Turn context sections that a Turn sends only when they differ from the
 * latest copy in history. Compaction keeps exactly that copy, byte for byte.
 */
export const LATEST_COPY_SECTION_TAGS: string[] = [
  ...Object.values(CAPABILITY_SECTION_TAG),
  SCRIPT_TOOLS_SECTION_TAG,
];

/** The latest copy of each given section in history, in tag order. */
export function latestSections(
  messages: PiMessage[],
  tags = LATEST_COPY_SECTION_TAGS,
): string[] {
  return tags.flatMap((tag) => latestTurnContextSection(messages, tag) ?? []);
}
