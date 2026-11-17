import { authorAttrs, renderTag, type TagAuthor } from "@/chat/input-tags";
import { escapeXml, unescapeXml } from "@/chat/xml";

const CURRENT_INSTRUCTION_TAG = "current-instruction";
const CURRENT_INSTRUCTION_OPEN_PREFIX = `<${CURRENT_INSTRUCTION_TAG}`;
const CURRENT_INSTRUCTION_OPEN_BARE = `<${CURRENT_INSTRUCTION_TAG}>`;
const CURRENT_INSTRUCTION_OPEN_ATTR_PREFIX = `<${CURRENT_INSTRUCTION_TAG} `;
const CURRENT_INSTRUCTION_CLOSE = `\n</${CURRENT_INSTRUCTION_TAG}>`;

function isCurrentInstructionOpeningTag(value: string): boolean {
  return (
    value === CURRENT_INSTRUCTION_OPEN_BARE ||
    (value.startsWith(CURRENT_INSTRUCTION_OPEN_ATTR_PREFIX) &&
      value.endsWith(">"))
  );
}

function readCurrentInstructionBody(text: string): string | undefined {
  const start = text.indexOf(CURRENT_INSTRUCTION_OPEN_PREFIX);
  if (start < 0) {
    return undefined;
  }
  const openingEnd = text.indexOf(">\n", start);
  if (openingEnd < 0) {
    return undefined;
  }
  const openingTag = text.slice(start, openingEnd + 1);
  if (!isCurrentInstructionOpeningTag(openingTag)) {
    return undefined;
  }
  const bodyStart = openingEnd + 2;
  const bodyEnd = text.indexOf(CURRENT_INSTRUCTION_CLOSE, bodyStart);
  if (bodyEnd < bodyStart) {
    return undefined;
  }
  return text.slice(bodyStart, bodyEnd);
}

/** Render the active user task in a stable prompt boundary. */
export function renderCurrentInstruction(
  instruction: string,
  attrs?: TagAuthor & { slackTs?: string },
): string {
  return renderTag(
    CURRENT_INSTRUCTION_TAG,
    { ...authorAttrs(attrs), slack_ts: attrs?.slackTs },
    [escapeXml(instruction)],
  );
}

/** Recover display text from the internal current-task prompt boundary. */
export function unwrapCurrentInstruction(text: string): string | undefined {
  const body = readCurrentInstructionBody(text);
  return body === undefined ? undefined : unescapeXml(body);
}
