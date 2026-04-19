import { truncateStatusText } from "@/chat/runtime/status-format";
import { normalizeSlackStatusText } from "@/chat/slack/mrkdwn";

const STATUS_PATTERNS = {
  thinking: {
    defaultContext: "…",
    variants: ["Thinking", "Reasoning", "Considering", "Working through"],
  },
  searching: {
    defaultContext: "sources",
    variants: ["Searching", "Scanning", "Probing", "Trawling"],
  },
  reading: {
    defaultContext: "task",
    variants: ["Reading", "Inspecting", "Parsing", "Skimming"],
  },
  reviewing: {
    defaultContext: "results",
    variants: ["Reviewing", "Checking", "Inspecting", "Auditing"],
  },
  drafting: {
    defaultContext: "reply",
    variants: ["Drafting", "Writing", "Composing", "Shaping"],
  },
  loading: {
    defaultContext: "task",
    variants: ["Loading", "Priming", "Booting", "Spinning up"],
  },
  updating: {
    defaultContext: "state",
    variants: ["Updating", "Patching", "Refreshing", "Adjusting"],
  },
  fetching: {
    defaultContext: "sources",
    variants: ["Fetching", "Pulling", "Retrieving", "Loading"],
  },
  creating: {
    defaultContext: "draft",
    variants: ["Creating", "Building", "Assembling", "Generating"],
  },
  listing: {
    defaultContext: "items",
    variants: ["Listing", "Gathering", "Collecting", "Enumerating"],
  },
  posting: {
    defaultContext: "reply",
    variants: ["Posting", "Sending", "Delivering", "Dispatching"],
  },
  adding: {
    defaultContext: "details",
    variants: ["Adding", "Applying", "Attaching", "Dropping in"],
  },
  running: {
    defaultContext: "tasks",
    variants: ["Running", "Executing", "Launching", "Processing"],
  },
} as const;

export type AssistantStatusKind = keyof typeof STATUS_PATTERNS;
export type AssistantStatusSource = "fallback" | "major";

export interface AssistantStatusSpec {
  kind: AssistantStatusKind;
  context?: string;
  source?: AssistantStatusSource;
}

interface AssistantStatusPresentation {
  key: string;
  visible: string;
}

/** Build a typed assistant status from a stable kind and optional context. */
export function makeAssistantStatus(
  kind: AssistantStatusKind,
  context?: string,
  options?: { source?: AssistantStatusSource },
): AssistantStatusSpec {
  return {
    kind,
    ...(context ? { context } : {}),
    ...(options?.source ? { source: options.source } : {}),
  };
}

/**
 * Render a typed status into Slack-facing strings.
 *
 * Randomized phrasing is product policy, not transport behavior, so keep it
 * separate from pacing and API-call concerns.
 */
export function renderAssistantStatus(args: {
  status: AssistantStatusSpec;
  random?: () => number;
}): AssistantStatusPresentation {
  const random = args.random ?? Math.random;
  const pattern = STATUS_PATTERNS[args.status.kind];
  const source = args.status.source ?? "fallback";
  const context =
    normalizeSlackStatusText(args.status.context ?? "") ||
    pattern.defaultContext;
  const index = Math.floor(random() * pattern.variants.length);
  const verb = pattern.variants[index] ?? pattern.variants[0];
  const visible = truncateStatusText(`${verb} ${context}`);

  return {
    key: `${source}:${args.status.kind}:${context}`,
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
