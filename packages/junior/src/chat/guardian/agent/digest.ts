/**
 * What the agent Guardian reads about one action: the authority digest that
 * code builds from core facts, and the read-only lookups of the second tier.
 * The digest holds the person's lines and the authority facts, so both tiers
 * start with them. The second tier can also read provenance and destination
 * facts.
 *
 * Code only labels and copies facts here. It decides who wrote each line
 * from the Run's Source and the authority record (`facts-from-junior`), and
 * gives each line of the person an id that the reviewer cites. Assistant
 * prose appears only as the agent message that a line of the person answers
 * (`bare-yes`). No tool result body appears anywhere: `readProvenance`
 * says only where a value came from.
 */
import { escapeTagText, renderTag, tagJson } from "@sentry/junior-plugin-api";
import type {
  AuthorityLineVia,
  AuthorityRecord,
} from "@/chat/guardian/authority";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE,
} from "@/chat/agent-invocations/result-event-type";
import type { GuardianDestinationFact } from "@/chat/guardian/policy";
import {
  ROOT_LINE_BREAK,
  type ToolActionProposal,
} from "@/chat/guardian/proposal";

/** Largest action, as JSON, that the agent Guardian reviews. */
const MAX_ACTION_CHARS = 64_000;

/** Largest agent message that a line of the person shows as its context. */
const MAX_IN_REPLY_TO_CHARS = 1_500;

/** Most tool calls that one provenance lookup lists. */
const MAX_PROVENANCE_CALLS = 20;

/** An action too large to review. Only that action fails (`bounded-failure`). */
class AgentGuardianActionTooLargeError extends Error {
  constructor(chars: number) {
    super(
      `The action is ${chars} characters, over the ${MAX_ACTION_CHARS} that review accepts.`,
    );
    this.name = "AgentGuardianActionTooLargeError";
  }
}

/**
 * Whose words the current message of the Run is.
 *
 * - `person`: a person sent it, so it is their own line.
 * - `automation`: the stored instruction of a scheduled Automation, which
 *   its creator wrote.
 * - `brief`: another agent handed over work with it: a parent agent's task
 *   or message, or another top-level agent's message. Guardian checked it
 *   when it was sent, so it is the instruction of this run
 *   (`brief-is-instruction`).
 * - `agent`: an Event wrote it, such as a Watch intent, an event task, or
 *   an agent result. It is context (`results-are-context`).
 */
type MessageAuthor = "person" | "automation" | "brief" | "agent";

function messageAuthor(context: ToolActionProposal["context"]): MessageAuthor {
  const { source } = context;
  if (source.kind === "scheduled_automation") {
    return "automation";
  }
  if (
    source.kind === "parent_message" ||
    (source.kind === "event" &&
      source.namespace === AGENT_INVOCATION_EVENT_NAMESPACE &&
      source.eventType === TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE)
  ) {
    return "brief";
  }
  const kind = source.kind;
  const personSource = kind === "slack" || kind === "local" || kind === "web";
  return personSource && context.actor.platform !== "system"
    ? "person"
    : "agent";
}

const VIA_LABELS: Record<
  AuthorityLineVia | "typed" | "automation" | "brief",
  string
> = {
  automation: "the creator, the stored instruction of this Automation",
  brief: "the brief that another agent handed over",
  instruction: "the person, the request that created this Watch",
  "linked-account": "the person, from their linked account",
  typed: "the person, typed in this conversation",
};

function splitLines(text: string): string[] {
  return text.split(ROOT_LINE_BREAK);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)} [truncated]`;
}

/** The authority digest of one action, and the person's lines by id. */
export interface AuthorityDigest {
  /** Ids that a citation may name: only lines that the person wrote. */
  personLines: ReadonlyMap<string, string>;
  text: string;
}

/**
 * Build the authority digest of one action: whose instruction it serves,
 * the person's lines with ids, the context lines of other authors, the
 * resources that the same instruction created, and earlier decisions.
 */
export function authorityDigest(
  proposal: ToolActionProposal,
  authority: AuthorityRecord | undefined,
): AuthorityDigest {
  const { context, rootConversation } = proposal;
  const current = messageAuthor(context);
  const ids = new Map<string, string>();
  const lines: string[] = [];
  const personLine = (
    text: string,
    via: keyof typeof VIA_LABELS,
    inReplyTo: string | undefined,
  ) => {
    const id = `P${ids.size + 1}`;
    ids.set(id, text);
    lines.push(`${id} (${VIA_LABELS[via]}):`);
    lines.push(...splitLines(text).map((line) => `  ${line}`));
    if (inReplyTo) {
      lines.push(
        `  in reply to the agent message: ${JSON.stringify(truncate(inReplyTo, MAX_IN_REPLY_TO_CHARS))}`,
      );
    }
  };
  lines.push(
    {
      automation:
        "Whose instruction: the creator of this Automation. Its stored instruction is their own line.",
      person:
        "Whose instruction: the person who sent the current message of this Turn.",
      brief:
        "Whose instruction: another agent handed over this work, and its brief is the instruction of this run. Judge each action against the brief.",
      agent:
        "Whose instruction: the person whose request started this work. An Event, such as a Watch Event or an agent result, wrote the current message of this run, so it is context.",
    }[current],
  );
  const messages = rootConversation?.messages ?? [];
  if (messages.length > 0) {
    lines.push(
      rootConversation?.truncated
        ? "Conversation, oldest first. Older messages are not shown."
        : "Conversation, oldest first.",
    );
  }
  // An agent message is shown only as the message that the next line of
  // the person answers.
  let lastAgentMessage: string | undefined;
  for (const message of messages) {
    if (message.author === "assistant") {
      lastAgentMessage = message.text;
      continue;
    }
    if (
      message.author === "user" &&
      (current === "person" || current === "brief")
    ) {
      personLine(
        message.text,
        current === "person" ? "typed" : "brief",
        lastAgentMessage,
      );
      lastAgentMessage = undefined;
      continue;
    }
    const label =
      message.author === "user" ? "agent (context)" : message.author;
    lines.push(...splitLines(message.text).map((line) => `${label}: ${line}`));
    if (message.author === "user") {
      lastAgentMessage = undefined;
    }
  }
  const currentShown = messages.some(
    (message) =>
      message.author === "user" && message.text === context.userIntent,
  );
  if ((current === "person" || current === "brief") && !currentShown) {
    personLine(
      context.userIntent,
      current === "person" ? "typed" : "brief",
      lastAgentMessage,
    );
  }
  if (current === "automation") {
    personLine(context.userIntent, "automation", undefined);
  }
  for (const line of authority?.lines ?? []) {
    personLine(line.text, line.via, undefined);
  }
  if (current === "agent") {
    if (ids.size === 0) {
      lines.push("No line of the person reaches this run.");
    }
    lines.push("Current message of this run (agent text, context only):");
    lines.push(...splitLines(context.userIntent).map((line) => `  ${line}`));
  }
  const created = authority?.created ?? [];
  if (created.length > 0) {
    lines.push(
      `Resources that the same instruction created: ${created.map((resource) => resource.ref).join(", ")}`,
    );
  }
  if (proposal.priorRejectedActions?.length) {
    lines.push(
      `Earlier decisions in this Turn (context, not precedent): ${tagJson(proposal.priorRejectedActions)}`,
    );
  }
  return {
    personLines: ids,
    text: renderTag("authority", {}, lines.map(escapeTagText)),
  };
}

/**
 * Render the exact action. The action is never cut. An action that does
 * not fit throws `AgentGuardianActionTooLargeError`.
 */
export function renderAction(proposal: ToolActionProposal): string {
  const { context } = proposal;
  const action = tagJson({
    tool: proposal.tool,
    input: proposal.input,
    ...(proposal.script ? { madeBy: "a Code Mode script" } : undefined),
    actor: context.actor,
    conversationId: context.conversationId,
    destination: context.destination,
    source: context.source,
    ...(context.credential ? { credential: context.credential } : undefined),
  });
  if (action.length > MAX_ACTION_CHARS) {
    throw new AgentGuardianActionTooLargeError(action.length);
  }
  return renderTag("planned-action", {}, [action]);
}

/**
 * `readProvenance`: where an exact `ref`, such as a file path, an id, or a
 * value, appears in this run. It names the person's lines that contain it,
 * the earlier tool calls and Code Mode script calls whose input contains
 * it, the tools whose results contain it, and whether the same instruction
 * created it. It never returns the body of a tool result.
 */
export function readProvenance(
  proposal: ToolActionProposal,
  digest: AuthorityDigest,
  authority: AuthorityRecord | undefined,
  ref: string,
): string {
  const calls: Array<{ input: string; tool: string }> = [];
  const resultsFrom: string[] = [];
  for (const entry of proposal.evidence?.entries ?? []) {
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
      inPersonLines: [...digest.personLines]
        .filter(([, text]) => text.includes(ref))
        .map(([id]) => id),
      createdBySameInstruction: (authority?.created ?? []).some(
        (resource) => resource.ref === ref,
      ),
      toolCalls: calls.slice(-MAX_PROVENANCE_CALLS),
      ...(proposal.script
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

/**
 * `readDestination`: who can read the destination of the action, when
 * core knows it, and the facts that the installed plugins declare about
 * their destinations, such as which ones people outside the organization
 * can read, and which domains get a plugin's credential.
 */
export function readDestination(
  destinationFacts: readonly GuardianDestinationFact[],
  authority: AuthorityRecord | undefined,
): string {
  return tagJson({
    ...(authority?.destinationReaders
      ? { readers: authority.destinationReaders }
      : undefined),
    pluginFacts: [...destinationFacts].sort((left, right) =>
      left.plugin.localeCompare(right.plugin),
    ),
  });
}
