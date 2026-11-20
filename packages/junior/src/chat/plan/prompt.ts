/**
 * How the model sees the plan, Lore-style: the model's own `updatePlan`
 * calls are already in history, so they get no block. A Turn adds a
 * `<plan-delta>` only for changes that others made since the highest
 * version that history shows. Compaction folds it all into one `<plan>`
 * snapshot of the open items. Both blocks start with that version as plain
 * text, and later deltas build on it.
 */
import type { PiMessage } from "@/chat/pi/messages";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import {
  escapeTagText,
  findTags,
  renderTag,
  startsWithTag,
} from "@sentry/junior-plugin-api";
import { planItemRef } from "./tool-output";
import {
  isOpenPlanItemStatus,
  SELF_PLAN_ASSIGNEE,
  type PlanItem,
  type PlanItemAssignee,
} from "./types";

/**
 * Turn context section with the plan changes that others made. Blocks are
 * append-only; context compaction replaces them with one `<plan>` snapshot.
 */
export const PLAN_DELTA_TAG = "plan-delta";

/** Compacted context block with every open Plan item. */
export const PLAN_SNAPSHOT_TAG = "plan";

// The version line starts the body. Escaped person text cannot write a
// tag, so it cannot fake this line.
const VERSION_LINE = /^Plan version (\d+)\./;

/** Render an assignee as the text that `updatePlan` accepts. */
export function renderPlanAssignee(assignee: PlanItemAssignee): string {
  switch (assignee.kind) {
    case "self":
      return SELF_PLAN_ASSIGNEE;
    case "agent":
      return assignee.name ?? assignee.conversationId;
    case "user":
      return assignee.email;
  }
}

function renderItem(item: PlanItem, withAuthor: boolean): string {
  const fields = [
    item.status,
    `assignee ${renderPlanAssignee(item.assignee)}`,
    ...(withAuthor && item.changedBy
      ? [
          `changed by ${item.changedBy.name ? `${item.changedBy.name} (${item.changedBy.email})` : item.changedBy.email}`,
        ]
      : []),
  ];
  const notes = item.notes ? `\n  Notes: ${item.notes}` : "";
  return escapeTagText(
    `- ${planItemRef(item.id)} (${fields.join(", ")}): ${item.title}${notes}`,
  );
}

function planVersion(items: readonly PlanItem[]): number {
  return Math.max(...items.map((item) => item.version));
}

function textParts(message: PiMessage): string[] {
  if (!("role" in message) || message.role !== "user") return [];
  const { content } = message;
  if (typeof content === "string") return [content];
  return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

/**
 * Return the highest plan version that history shows, from runtime blocks
 * only: a `<plan-delta>` in a Turn context or a `<plan>` in a compaction
 * summary. Text that people write is escaped, so it cannot fake one.
 */
export function latestSeenPlanVersion(messages: readonly PiMessage[]): number {
  let seen = 0;
  for (const message of messages) {
    for (const text of textParts(message)) {
      if (
        !startsWithTag(text, [TURN_CONTEXT_TAG]) &&
        !isCompactionSummaryText(text)
      ) {
        continue;
      }
      for (const tag of [PLAN_SNAPSHOT_TAG, PLAN_DELTA_TAG]) {
        for (const block of findTags(text, tag)) {
          const version = VERSION_LINE.exec(block.body)?.[1];
          if (version) seen = Math.max(seen, Number(version));
        }
      }
    }
  }
  return seen;
}

/**
 * Render the changes that people made after the version that history
 * shows, or null when there are none. Changes of the plan's own agent are
 * left out: its tool calls and results are already in history.
 */
export function renderPlanDelta(
  items: readonly PlanItem[],
  seenVersion: number,
): string | null {
  const changed = items.filter(
    (item) => item.changedBy && item.version > seenVersion,
  );
  if (changed.length === 0) return null;
  return renderTag(PLAN_DELTA_TAG, {}, [
    `Plan version ${planVersion(items)}. People changed these items of your plan since you last saw it. Each item shows its current fields.`,
    ...changed.map((item) => renderItem(item, true)),
  ]);
}

/**
 * Render every open item as one snapshot, or null when the plan has no
 * items. A plan with only closed items still gets a block, so its version
 * stays in history.
 */
export function renderPlanSnapshot(items: readonly PlanItem[]): string | null {
  if (items.length === 0) return null;
  const open = items.filter((item) => isOpenPlanItemStatus(item.status));
  return renderTag(PLAN_SNAPSHOT_TAG, {}, [
    `Plan version ${planVersion(items)}. ${
      open.length > 0
        ? "The open items of your plan."
        : "Your plan has no open items."
    }`,
    ...open.map((item) => renderItem(item, false)),
  ]);
}
