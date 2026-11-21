import {
  escapeTagTextAndQuotes,
  findTag,
  renderTag,
  unescapeTagText,
} from "@sentry/junior-plugin-api";
import { authorAttrs, type TagAuthor } from "@/chat/input-tags";

const CURRENT_INSTRUCTION_TAG = "current-instruction";

/** Render the active user task in a stable prompt boundary. */
export function renderCurrentInstruction(
  instruction: string,
  attrs?: TagAuthor & { slackTs?: string },
): string {
  return renderTag(
    CURRENT_INSTRUCTION_TAG,
    { ...authorAttrs(attrs), slack_ts: attrs?.slackTs },
    [escapeTagTextAndQuotes(instruction)],
  );
}

/**
 * Return whether the text holds a `<current-instruction>`. Person text is
 * escaped, so only the runtime can write one.
 */
export function hasCurrentInstruction(text: string): boolean {
  return findTag(text, CURRENT_INSTRUCTION_TAG) !== undefined;
}

/** Recover display text from the internal current-task prompt boundary. */
export function unwrapCurrentInstruction(text: string): string | undefined {
  const block = instructionBlock(text);
  return block === undefined ? undefined : unescapeTagText(block.body);
}

// Only the block form that renderCurrentInstruction writes is an
// instruction: the opening and closing tags each end or start a line.
function instructionBlock(text: string) {
  const block = findTag(text, CURRENT_INSTRUCTION_TAG);
  if (!block) return undefined;
  const bodyStart = block.start + block.opening.length;
  // The closing tag is `</`, the name, and `>`.
  const closeStart = block.end - CURRENT_INSTRUCTION_TAG.length - 3;
  return text[bodyStart] === "\n" && text[closeStart - 1] === "\n"
    ? block
    : undefined;
}
