import { escapeXml } from "@/chat/xml";

const CURRENT_INSTRUCTION_TAG = "current-instruction";
const CURRENT_INSTRUCTION_PATTERN = new RegExp(
  `<${CURRENT_INSTRUCTION_TAG}>\\n([\\s\\S]*?)\\n</${CURRENT_INSTRUCTION_TAG}>`,
);

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/** Render the active user task in a stable prompt boundary. */
export function renderCurrentInstruction(instruction: string): string {
  return [
    `<${CURRENT_INSTRUCTION_TAG}>`,
    escapeXml(instruction),
    `</${CURRENT_INSTRUCTION_TAG}>`,
  ].join("\n");
}

/** Recover display text from the internal current-task prompt boundary. */
export function unwrapCurrentInstruction(text: string): string | undefined {
  const match = text.match(CURRENT_INSTRUCTION_PATTERN);
  if (!match) {
    return undefined;
  }
  return unescapeXml(match[1]);
}
