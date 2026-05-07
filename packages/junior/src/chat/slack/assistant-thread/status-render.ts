import { truncateStatusText } from "@/chat/runtime/status-format";
import { normalizeSlackStatusText } from "@/chat/slack/mrkdwn";

const DEFAULT_STATUS_CONTEXTS = {
  thinking: "…",
  searching: "sources",
  reading: "task",
  reviewing: "results",
  drafting: "reply",
  running: "tasks",
} as const;

type AssistantStatusVerb = keyof typeof DEFAULT_STATUS_CONTEXTS;

export interface AssistantStatusSpec {
  text: string;
}

interface AssistantStatusPresentation {
  key: string;
  visible: string;
}

function formatAssistantStatusText(verb: string, context?: string): string {
  const normalizedVerb = normalizeSlackStatusText(verb).trim().toLowerCase();
  const normalizedContext =
    normalizeSlackStatusText(context ?? "") ||
    DEFAULT_STATUS_CONTEXTS[
      normalizedVerb as keyof typeof DEFAULT_STATUS_CONTEXTS
    ] ||
    "";

  if (!normalizedVerb) {
    return truncateStatusText(normalizedContext || "Working");
  }

  const displayVerb = `${normalizedVerb[0]?.toUpperCase() ?? ""}${normalizedVerb.slice(1)}`;
  return truncateStatusText(
    normalizedContext ? `${displayVerb} ${normalizedContext}` : displayVerb,
  );
}

/** Build assistant progress text from a verb and optional context. */
export function makeAssistantStatus(
  verb: AssistantStatusVerb,
  context?: string,
): AssistantStatusSpec {
  return {
    text: formatAssistantStatusText(verb, context),
  };
}

/** Normalize a progress update into the visible Slack loading copy. */
export function renderAssistantStatus(args: {
  status: AssistantStatusSpec;
}): AssistantStatusPresentation {
  const visible = truncateStatusText(
    normalizeSlackStatusText(args.status.text),
  );

  return {
    key: visible,
    visible,
  };
}

/** Select and normalize the loading messages used for Slack status rotation. */
export function selectAssistantLoadingMessages(args: {
  messages: string[];
  random?: () => number;
}): string[] | undefined {
  const random = args.random ?? Math.random;
  const normalized = Array.from(
    new Set(
      args.messages
        .map((message) => truncateStatusText(normalizeSlackStatusText(message)))
        .filter((message) => message.length > 0),
    ),
  );

  if (normalized.length === 0) {
    return undefined;
  }

  const shuffled = [...normalized];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const otherIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[otherIndex]] = [
      shuffled[otherIndex] as string,
      shuffled[index] as string,
    ];
  }

  return shuffled.slice(0, 10);
}
