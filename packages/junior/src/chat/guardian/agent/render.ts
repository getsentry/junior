/**
 * What the agent Guardian reads about one action: the ordered messages of
 * the work, the exact action with the facts of its call, and the read-only
 * provenance lookup of the second tier.
 *
 * Code only renders facts here. No tool result body appears anywhere:
 * `readProvenance` says only where a value came from.
 */
import { escapeTagText, renderTag, tagJson } from "@sentry/junior-plugin-api";
import type { Action, Message, ReviewRequest } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

/** Largest action, as JSON, that the agent Guardian reviews. */
const MAX_ACTION_CHARS = 64_000;

/** Most tool calls that one provenance lookup lists. */
const MAX_PROVENANCE_CALLS = 20;

/** An action too large to review. Only it fails (`bounded-failure`). */
class AgentGuardianActionTooLargeError extends Error {
  constructor(chars: number) {
    super(
      `The action is ${chars} characters, over the ${MAX_ACTION_CHARS} that review accepts.`,
    );
    this.name = "AgentGuardianActionTooLargeError";
  }
}

/** Render the messages of the work, oldest first, each with its author. */
export function renderMessages(messages: readonly Message[]): string {
  const lines = messages.flatMap((message) =>
    message.text.split("\n").map((line) => `[${message.from}] ${line}`),
  );
  return renderTag(
    "messages",
    {},
    lines.length > 0
      ? lines.map(escapeTagText)
      : ["No message reaches this run."],
  );
}

/**
 * Render the exact action. The action is never cut. An action that does
 * not fit throws `AgentGuardianActionTooLargeError`.
 */
export function renderAction(
  action: Action,
  sandbox: ReviewRequest["sandbox"],
  madeByScript: boolean,
): string {
  const text = tagJson({
    tool: action.tool,
    ...(action.target ? { target: action.target } : undefined),
    ...(action.summary ? { summary: action.summary } : undefined),
    // The plugin's reason is a label for records. The policy says what
    // each decision means.
    ...(action.toolDecision
      ? { toolDecision: action.toolDecision.decision }
      : undefined),
    input: action.input,
    ...(action.serverHints
      ? { untrustedServerHints: action.serverHints }
      : undefined),
    // The credential placeholders of the Sandbox (`placeholders`).
    ...(sandbox && action.tool === "bash" ? { sandbox } : undefined),
    ...(madeByScript ? { madeBy: "a Code Mode script" } : undefined),
  });
  if (text.length > MAX_ACTION_CHARS) {
    throw new AgentGuardianActionTooLargeError(text.length);
  }
  const planned = renderTag("planned-action", {}, [text]);
  // Plugin code wrote these lines from stored records (`guardian.context`).
  return action.context
    ? `${planned}\n\n${renderTag("plugin-context", {}, action.context.map(escapeTagText))}`
    : planned;
}

/**
 * `readProvenance`: where an exact `ref`, such as a file path, an id, or a
 * value, appears in this run. It names whether an `instruction` message
 * contains it, the earlier tool calls and Code Mode script calls whose
 * input contains it, and the tools whose results contain it. It never
 * returns the body of a tool result.
 */
export function readProvenance(
  messages: readonly Message[],
  proposal: ToolActionProposal | undefined,
  ref: string,
): string {
  const calls: Array<{ input: string; tool: string }> = [];
  const resultsFrom: string[] = [];
  for (const entry of proposal?.evidence?.entries ?? []) {
    if (!entry.text.includes(ref)) {
      continue;
    }
    const tool = /^tool (.+) (call|result)$/.exec(entry.role);
    if (tool?.[2] === "call") {
      calls.push({ tool: tool[1]!, input: entry.text });
    } else if (tool) {
      resultsFrom.push(tool[1]!);
    }
  }
  return renderTag("untrusted-data", {}, [
    tagJson({
      ref,
      inMessages: [
        ...new Set(
          messages
            .filter((message) => message.text.includes(ref))
            .map((message) => message.from),
        ),
      ],
      toolCalls: calls.slice(-MAX_PROVENANCE_CALLS),
      ...(proposal?.script
        ? {
            scriptCalls: proposal.script.calls
              .filter((call) => call.input.includes(ref))
              .slice(-MAX_PROVENANCE_CALLS),
          }
        : undefined),
      toolResultsFrom: resultsFrom,
    }),
  ]);
}
