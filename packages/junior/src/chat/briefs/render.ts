import type { BriefInput } from "./schema";
import type { GeneratedBrief } from "./generate";

function list(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function escapeLabel(label: string): string {
  return label.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "not reported" : `$${costUsd.toFixed(6)}`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatRecordCodeChange(
  change: GeneratedBrief["brief"]["record"]["codeChanges"][number],
): string {
  const dates = [
    change.openedAt ? `opened ${change.openedAt}` : undefined,
    change.mergedAt ? `merged ${change.mergedAt}` : undefined,
    change.closedAt ? `closed ${change.closedAt}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return `[${escapeLabel(`${change.repository}#${change.number}${change.title ? ` · ${change.title}` : ""}`)}](${change.url}) · ${change.state}${dates.length ? ` · ${dates.join(" · ")}` : ""}`;
}

/** Render the final Brief and its local evidence check as readable Markdown. */
export function renderBriefMarkdown(args: {
  generation: GeneratedBrief;
  input: BriefInput;
  model: string;
  totalCostUsd?: number;
  versionCount: number;
}): string {
  const { brief, evidence } = args.generation;
  const links = brief.links.map(
    (link) =>
      `[${escapeLabel(link.label)}](${link.url}) · ${link.kind}${link.status ? ` · ${link.status}` : ""}`,
  );
  const dropped = evidence.droppedUrls.length
    ? evidence.droppedUrls.map(
        (url) => `raw \`${url.raw}\` · normalized \`${url.normalized}\``,
      )
    : ["None"];
  const record = brief.record;
  const location = record.location
    ? `${record.location.provider}${record.location.channelName ? ` · ${record.location.channelName}` : ""}`
    : "None";
  return [
    `# ${args.input.title ?? `Brief ${args.input.conversationId}`}`,
    "",
    "## Record",
    "",
    `- Started: ${record.startedAt}`,
    `- Last activity: ${record.lastActivityAt}`,
    `- Duration: ${record.durationMs} ms`,
    `- Location: ${location}`,
    `- Messages: ${formatCount(record.userMessages, "user message")} · ${formatCount(record.assistantMessages, "assistant message")} · ${formatCount(record.toolResults, "tool result")}`,
    `- Events: ${record.events}`,
    `- Turns: ${record.turns ?? "not reported"}`,
    "- Participants:",
    ...list(
      record.participants.map(
        (participant) =>
          `${participant.name} · ${participant.messages} message${participant.messages === 1 ? "" : "s"}`,
      ),
      "None.",
    )
      .split("\n")
      .map((line) => `  ${line}`),
    "- Code changes:",
    ...list(record.codeChanges.map(formatRecordCodeChange), "None.")
      .split("\n")
      .map((line) => `  ${line}`),
    "",
    "## Summary",
    "",
    brief.summary,
    "",
    "## Intent",
    "",
    brief.intent,
    "",
    `## Outcome · ${brief.outcome.status}`,
    "",
    brief.outcome.text,
    "",
    "## Decisions",
    "",
    "### Stated",
    "",
    list(
      brief.decisions
        .filter((decision) => decision.kind === "stated")
        .map(
          (decision) =>
            `${decision.text}${decision.by ? ` — ${decision.by}` : ""}`,
        ),
      "None.",
    ),
    "",
    "### Confirmed",
    "",
    list(
      brief.decisions
        .filter((decision) => decision.kind === "confirmed")
        .map(
          (decision) =>
            `${decision.text}${decision.by ? ` — ${decision.by}` : ""}`,
        ),
      "None.",
    ),
    "",
    "### Assumed by Junior (not confirmed)",
    "",
    list(
      brief.decisions
        .filter((decision) => decision.kind === "assumed")
        .map(
          (decision) =>
            `${decision.text}${decision.by ? ` — ${decision.by}` : ""}`,
        ),
      "None.",
    ),
    "",
    "## Open decisions",
    "",
    list(
      brief.openDecisions.map(
        (decision) =>
          `${decision.text}${decision.owner ? ` — ${decision.owner}` : ""}`,
      ),
      "None.",
    ),
    "",
    "## Facts",
    "",
    list(brief.facts, "None."),
    "",
    "## Links",
    "",
    list(links, "None."),
    "",
    "## Keywords",
    "",
    brief.keywords.join(", ") || "None.",
    "",
    "---",
    "",
    "### Evidence check",
    "",
    `- Conversation: \`${args.input.conversationId}\``,
    `- Through index: ${args.generation.throughIndex}`,
    `- Versions generated: ${args.versionCount}`,
    `- Model: \`${args.model}\``,
    `- Code changes: ${evidence.codeChangeCount}`,
    `- Resources: ${evidence.resourceCount}`,
    `- Model URLs: ${evidence.keptUrlCount} kept of ${evidence.citedUrlCount}`,
    `- Coerced decision kinds: ${evidence.coercedDecisionKinds}`,
    `- Dropped attributions: ${evidence.droppedAttributionCount}`,
    `- Dropped runtime-marker items: ${evidence.droppedRuntimeMarkerCount}`,
    `- Merged claim without evidence: ${evidence.mergedClaimWithoutEvidence ? "yes" : "no"}`,
    `- Cost: ${formatCost(args.totalCostUsd)}`,
    "- Dropped URLs:",
    ...dropped.map((url) => `  - ${url}`),
    "",
  ].join("\n");
}
