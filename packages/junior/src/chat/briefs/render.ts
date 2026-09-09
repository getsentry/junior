import type { BriefInput } from "./input";
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
    ? evidence.droppedUrls.map((url) => `\`${url}\``)
    : ["None"];
  return [
    `# ${args.input.title ?? `Brief ${args.input.conversationId}`}`,
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
    list(
      brief.decisions.map(
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
    `- Cost: ${formatCost(args.totalCostUsd)}`,
    "- Dropped URLs:",
    ...dropped.map((url) => `  - ${url}`),
    "",
  ].join("\n");
}
