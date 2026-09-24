import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import type { MemoryDb } from "../store";
import { gapListInputSchema, listGaps } from "./store";
import { GAP_CATEGORIES, GAP_IMPACTS, GAP_REVIEW_STATES } from "./types";

const labels: Record<string, string> = {
  knowledge: "Data or knowledge",
  capability: "Tool capability",
  permission: "Permission",
  tool_failure: "Tool failure",
  blocked: "Blocked",
  workaround: "Workaround",
  uncertain_answer: "Uncertain answer",
  unreviewed: "Unreviewed",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
};

/** Project the observation log through the shared dashboard list. */
export function createGapUserPage(): PluginUserPageDefinition {
  return {
    id: "gaps",
    label: "Gaps",
    navigation: "primary",
    description:
      "Observed limitations, not permanent facts. Private observations stay private. Only the owner can review an observation.",
    async read(ctx, input) {
      const [key, value] = (input.filter ?? "").split(":");
      const filters = gapListInputSchema.parse({
        limit: input.limit,
        cursor: input.cursor,
        query: input.query,
        category: key === "category" ? value : undefined,
        impact: key === "impact" ? value : undefined,
        reviewState: key === "state" ? value : undefined,
        days: key === "days" ? Number(value) : undefined,
      });
      const page = await listGaps(ctx.db as MemoryDb, ctx.viewer.id, filters);
      return {
        type: "list",
        emptyText: "No gap observations match these filters.",
        searchPlaceholder: "Search gap observations",
        filters: [
          { label: "All observations", value: "" },
          ...[7, 30, 90].map((days) => ({
            label: `Last ${days} days`,
            value: `days:${days}`,
          })),
          ...GAP_CATEGORIES.map((value) => ({
            label: `Category: ${labels[value]}`,
            value: `category:${value}`,
          })),
          ...GAP_IMPACTS.map((value) => ({
            label: `Impact: ${labels[value]}`,
            value: `impact:${value}`,
          })),
          ...GAP_REVIEW_STATES.map((value) => ({
            label: `Review: ${labels[value]}`,
            value: `state:${value}`,
          })),
        ],
        metrics: GAP_CATEGORIES.map((category) => ({
          label: labels[category]!,
          value: String(
            page.counts.find((row) => row.category === category)?.turns ?? 0,
          ),
          detail:
            "Distinct affected Turns matching the filter, not grouped gap frequency.",
        })),
        nextCursor: page.nextCursor,
        records: page.gaps.map((gap) => ({
          id: gap.id,
          title: gap.description,
          href: `/conversations/${encodeURIComponent(gap.conversationId)}`,
          description: gap.explanation,
          metadata: [
            { label: "Category", value: labels[gap.category]! },
            { label: "Impact", value: labels[gap.impact]! },
            { label: "Review", value: labels[gap.reviewState]! },
            {
              label: "Evidence",
              value:
                gap.evidenceKind === "tool"
                  ? "Tool cited; not yet proof of root cause"
                  : "Reported; no tool evidence cited",
            },
            {
              label: "Visibility",
              value: gap.scope === "public" ? "Public" : "Private",
            },
            {
              label: "Observed (UTC)",
              value: new Date(gap.observedAtMs).toISOString(),
            },
            { label: "Turn", value: gap.turnId },
          ],
          actions:
            gap.ownerUserId === ctx.viewer.id
              ? GAP_REVIEW_STATES.filter(
                  (state) => state !== gap.reviewState,
                ).map((state) => ({
                  label:
                    state === "confirmed"
                      ? "Confirm"
                      : state === "dismissed"
                        ? "Dismiss"
                        : "Reset review",
                  href: `/api/plugins/memory/gaps/${gap.id}/${state}`,
                  method: "POST" as const,
                  tone: "neutral" as const,
                }))
              : [],
        })),
      };
    },
  };
}
