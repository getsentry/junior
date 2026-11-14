/**
 * How the model sees the plan, Lore-style: the model's own `updatePlan`
 * calls are already in history, so they get no block. A Turn adds a
 * `<plan-delta>` only for changes that others made since the highest
 * version that history shows. Compaction folds it all into one `<plan>`
 * snapshot of the open items. Both blocks carry that version, and later
 * deltas build on it.
 */
import type { PiMessage } from "@/chat/pi/messages";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import { escapeXml, escapeXmlText } from "@/chat/xml";
import {
  isOpenPlanItemStatus,
  type PlanItem,
  type PlanItemAssignee,
} from "./types";

/** Turn context section with the plan changes that others made. */
export const PLAN_DELTA_TAG = "plan-delta";

/** Compacted context block with every open Plan item. */
export const PLAN_SNAPSHOT_TAG = "plan";

const VERSION_PATTERN = new RegExp(
  `<(?:${PLAN_SNAPSHOT_TAG}|${PLAN_DELTA_TAG}) version="(\\d+)">`,
  "g",
);

/** Render an assignee as the text that `updatePlan` accepts. */
export function renderPlanAssignee(assignee: PlanItemAssignee): string {
  switch (assignee.kind) {
    case "self":
      return "self";
    case "agent":
      return assignee.name ?? assignee.conversationId;
    case "user":
      return assignee.email;
  }
}

function renderItem(item: PlanItem, withAuthor: boolean): string {
  const attributes = [
    `id="${item.id}"`,
    `status="${item.status}"`,
    `assignee="${escapeXml(renderPlanAssignee(item.assignee))}"`,
    ...(withAuthor && item.changedBy
      ? [
          `author="${escapeXml(item.changedBy.name ?? item.changedBy.email)}"`,
          `email="${escapeXml(item.changedBy.email)}"`,
        ]
      : []),
  ];
  const notes = item.notes
    ? `\n<notes>${escapeXmlText(item.notes)}</notes>`
    : "";
  return `<item ${attributes.join(" ")}>${escapeXmlText(item.title)}${notes}</item>`;
}

function planVersion(items: readonly PlanItem[]): number {
  return Math.max(...items.map((item) => item.version));
}

function textParts(message: PiMessage): string[] {
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user" || !Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const text = (part as { type?: unknown; text?: unknown } | undefined)?.text;
    return typeof text === "string" ? [text] : [];
  });
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
        !text.startsWith(`<${TURN_CONTEXT_TAG}>`) &&
        !isCompactionSummaryText(text)
      ) {
        continue;
      }
      for (const match of text.matchAll(VERSION_PATTERN)) {
        seen = Math.max(seen, Number(match[1]));
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
  return [
    `<${PLAN_DELTA_TAG} version="${planVersion(items)}">`,
    "People changed these items of your plan since you last saw it. Each item shows its current fields.",
    ...changed.map((item) => renderItem(item, true)),
    `</${PLAN_DELTA_TAG}>`,
  ].join("\n");
}

/**
 * Render every open item as one snapshot, or null when the plan has no
 * items. A plan with only closed items still gets a block, so its version
 * stays in history.
 */
export function renderPlanSnapshot(items: readonly PlanItem[]): string | null {
  if (items.length === 0) return null;
  const open = items.filter((item) => isOpenPlanItemStatus(item.status));
  return [
    `<${PLAN_SNAPSHOT_TAG} version="${planVersion(items)}">`,
    open.length > 0
      ? "The open items of your plan."
      : "Your plan has no open items.",
    ...open.map((item) => renderItem(item, false)),
    `</${PLAN_SNAPSHOT_TAG}>`,
  ].join("\n");
}
