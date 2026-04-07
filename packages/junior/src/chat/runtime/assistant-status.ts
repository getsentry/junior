import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import { getSlackClient } from "@/chat/slack/client";
import { truncateStatusText } from "@/chat/runtime/status-format";

const PLAYFUL_STATUS_PREFIXES = [
  "Poking around",
  "Digging in",
  "Stirring the pot",
  "Shaking the tree",
  "Following the breadcrumbs",
  "Untangling things",
  "Wrestling the gremlins",
  "Doing wizard stuff",
  "Chasing threads",
  "Turning over rocks",
  "Kicking the tires",
  "Reading the tea leaves",
  "Connecting the dots",
  "Sniffing around",
  "Rummaging through it",
  "Peeling it apart",
  "Tracing the wires",
  "Walking the maze",
  "Looking under the hood",
  "Tinkering with it",
  "Threading the needle",
  "Hunting it down",
  "Cross-checking things",
  "Patching things up",
  "Tightening the bolts",
  "Greasing the gears",
  "Surveying the scene",
  "Taking it apart",
  "Putting it back together",
  "Pressure-testing it",
  "Following the trail",
  "Working the angles",
  "Checking the corners",
  "Reading the room",
  "Making sense of it",
  "Sorting the pile",
  "Clearing the brush",
  "Walking the graph",
  "Tracking it down",
  "Prodding at it",
  "Stress-testing the edges",
  "Testing the waters",
  "Counting the moving parts",
  "Turning the crank",
  "Checking the seams",
  "Unspooling the thread",
  "Picking the lock",
  "Inspecting the joints",
  "Dusting for clues",
  "Following the map",
  "Juggling the pieces",
  "Reading between the lines",
  "Shuffling the deck",
  "Working the backlog",
  "Tugging on the thread",
  "Peeking behind the curtain",
  "Scanning the horizon",
  "Sweeping the floor",
  "Sifting the evidence",
  "Tracing the path",
  "Walking the branches",
  "Checking the pulse",
  "Turning the pages",
  "Dialing it in",
  "Straightening the stack",
  "Checking the gears",
  "Tuning the engine",
  "Chipping away",
  "Working the problem",
  "Leaning into it",
  "Finding the edges",
  "Following the signal",
  "Sweating the details",
  "Pulling the thread",
  "Filling the gaps",
  "Connecting the wires",
  "Testing a hunch",
  "Rounding up the pieces",
  "Walking through it",
  "Reading the signs",
  "Tracing the outline",
  "Scrubbing through it",
  "Picking through it",
  "Untying knots",
  "Lining things up",
  "Balancing the pieces",
  "Working through the wrinkles",
  "Sharpening the edges",
  "Tidying the trail",
  "Following the current",
  "Digging up details",
  "Checking the bearings",
  "Looking for cracks",
  "Pressing on it",
  "Measuring twice",
  "Scanning for splinters",
  "Walking the perimeter",
  "Turning up clues",
  "Brushing off the dust",
  "Finding the clean line",
  "Checking the fit",
  "Sketching the shape",
  "Triangulating it",
  "Shaking loose details",
  "Sorting signal from noise",
  "Pinning it down",
  "Reading the grain",
  "Following the scent",
  "Checking my footing",
  "Untangling the stack",
  "Making the pieces click",
] as const;

/**
 * Slack assistant status transport contract.
 *
 * Slack's `assistant.threads.setStatus` API auto-clears after roughly two
 * minutes if no message is sent, so callers must refresh non-empty statuses
 * periodically during long-running work and clear them explicitly with an
 * empty status when the turn ends.
 */
export interface AssistantStatusTransport {
  /** Best-effort update for the visible assistant status in a Slack thread. */
  setStatus: (
    channelId: string,
    threadTs: string,
    status: string,
    suggestions?: string[],
  ) => Promise<void>;
}

/**
 * Rendered Slack assistant status payload.
 *
 * `hint` is the semantic phase emitted by the runtime, such as
 * "Reading file respond.ts". `visible` is the playful Slack-facing string we
 * actually show, while `suggestions` preserves the visible text and semantic
 * hint for transports that support `loading_messages`.
 */
export interface AssistantStatusPresentation {
  hint: string;
  visible: string;
  suggestions?: string[];
}

/**
 * Normalize semantic status hints before they are rendered for Slack.
 *
 * Callers may pass strings with trailing ellipses or incidental whitespace.
 * Slack's assistant status hard-limits visible text to 50 characters, so hints
 * are trimmed, de-ellipsized, and truncated up front.
 */
export function normalizeAssistantStatusHint(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return truncateStatusText(trimmed.replace(/(?:\.\s*)+$/, "").trim());
}

/**
 * Convert a semantic status hint into the Slack-facing assistant status.
 *
 * The runtime continues to emit semantic hints for tool and sandbox phases.
 * This renderer adds a playful prefix while preserving the hint inside the
 * final visible string, then prepares `loading_messages` suggestions so the
 * transport can expose both the playful copy and the underlying phase detail.
 */
export function buildAssistantStatusPresentation(args: {
  hint: string;
  currentVisible?: string;
  random?: () => number;
}): AssistantStatusPresentation {
  const hint = normalizeAssistantStatusHint(args.hint);
  const random = args.random ?? Math.random;
  const prefix = pickNextPrefix(args.currentVisible, random);
  const visible = hint
    ? truncateStatusText(`${prefix}: ${hint}`)
    : truncateStatusText(`${prefix}...`);
  const suggestions = Array.from(
    new Set(
      [visible, hint].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  );

  return {
    hint,
    visible,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

/** Create a best-effort Slack adapter transport for assistant status updates. */
export function createSlackAdapterAssistantStatusTransport(args: {
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantStatus">;
}): AssistantStatusTransport {
  return {
    async setStatus(channelId, threadTs, status, suggestions) {
      try {
        await args
          .getSlackAdapter()
          .setAssistantStatus(channelId, threadTs, status, suggestions);
      } catch (error) {
        logAssistantStatusFailure(status, error);
      }
    },
  };
}

/**
 * Create a best-effort Web API transport for assistant status updates.
 *
 * This is used by flows that do not have a chat adapter instance handy, such
 * as OAuth resume handlers, but it still follows the same status semantics and
 * `loading_messages` payload shape as the adapter-backed runtime path.
 */
export function createSlackWebApiAssistantStatusTransport(args?: {
  getSlackClient?: typeof getSlackClient;
}): AssistantStatusTransport {
  const getClient = args?.getSlackClient ?? getSlackClient;
  return {
    async setStatus(channelId, threadTs, status, suggestions) {
      try {
        await getClient().assistant.threads.setStatus({
          channel_id: channelId,
          thread_ts: threadTs,
          status,
          ...(suggestions ? { loading_messages: suggestions } : {}),
        });
      } catch (error) {
        logAssistantStatusFailure(status, error);
      }
    },
  };
}

function pickNextPrefix(
  currentVisible: string | undefined,
  random: () => number,
): string {
  const currentPrefix = extractPrefix(currentVisible);
  const options = PLAYFUL_STATUS_PREFIXES.filter(
    (prefix) => prefix !== currentPrefix,
  );
  const pool = options.length > 0 ? options : [...PLAYFUL_STATUS_PREFIXES];
  const index = Math.floor(random() * pool.length);
  return pool[index] ?? PLAYFUL_STATUS_PREFIXES[0];
}

function extractPrefix(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const delimiterIndex = value.indexOf(":");
  if (delimiterIndex >= 0) {
    return value.slice(0, delimiterIndex).trim();
  }

  return value.replace(/(?:\.\s*)+$/, "").trim() || undefined;
}

function logAssistantStatusFailure(status: string, error: unknown): void {
  logWarn(
    "assistant_status_update_failed",
    {},
    {
      "app.slack.status_text": status || "(clear)",
      "error.message": error instanceof Error ? error.message : String(error),
    },
    "Failed to update assistant status",
  );
}
