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

export interface AssistantStatusSpec {
  kind: AssistantStatusKind;
  context?: string;
}

export interface AssistantStatusPresentation {
  key: string;
  hint: string;
  visible: string;
  suggestions?: string[];
}

/** Build a typed assistant status from a stable kind and optional context. */
export function makeAssistantStatus(
  kind: AssistantStatusKind,
  context?: string,
): AssistantStatusSpec {
  return { kind, ...(context ? { context } : {}) };
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
  const context =
    normalizeSlackStatusText(args.status.context ?? "") ||
    pattern.defaultContext;
  const index = Math.floor(random() * pattern.variants.length);
  const verb = pattern.variants[index] ?? pattern.variants[0];
  const visible = truncateStatusText(`${verb} ${context}`);
  const hint = truncateStatusText(`${pattern.variants[0]} ${context}`);

  return {
    key: `${args.status.kind}:${context}`,
    hint,
    visible,
    suggestions: Array.from(new Set([visible, hint])),
  };
}
