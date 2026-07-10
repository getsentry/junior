import { escapeXml, unescapeXml } from "@/chat/xml";

const TASK_OPEN = "<advisor-task>\n";
const TASK_CLOSE = "\n</advisor-task>";
const CONTEXT_OPEN = "<executor-context>\n";
const CONTEXT_CLOSE = "\n</executor-context>";

/** Render the executor's advisor request in stable model-facing boundaries. */
export function renderAdvisorRequest(
  question: string,
  context: string,
): string {
  return [
    TASK_OPEN,
    escapeXml(question),
    TASK_CLOSE,
    "\n\n",
    CONTEXT_OPEN,
    escapeXml(context),
    CONTEXT_CLOSE,
  ].join("");
}

/** Recover readable task and context text from an advisor request message. */
export function unwrapAdvisorRequest(text: string): string | undefined {
  if (!text.startsWith(TASK_OPEN) || !text.endsWith(CONTEXT_CLOSE)) {
    return undefined;
  }

  const taskEnd = text.indexOf(TASK_CLOSE, TASK_OPEN.length);
  if (taskEnd < 0) {
    return undefined;
  }
  const contextStart = taskEnd + TASK_CLOSE.length + 2;
  if (!text.startsWith(CONTEXT_OPEN, contextStart)) {
    return undefined;
  }

  const task = text.slice(TASK_OPEN.length, taskEnd);
  const context = text.slice(
    contextStart + CONTEXT_OPEN.length,
    -CONTEXT_CLOSE.length,
  );
  return `${unescapeXml(task)}\n\nExecutor context:\n${unescapeXml(context)}`;
}
