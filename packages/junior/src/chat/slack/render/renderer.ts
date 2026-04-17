import {
  escapeSlackMrkdwnText,
  type SlackMessageBlock,
  type SlackMrkdwnText,
} from "@/chat/slack/render/blocks";
import type {
  AlertIntent,
  ComparisonTableIntent,
  PlainReplyIntent,
  ProgressPlanIntent,
  ResultCarouselIntent,
  SlackRenderIntent,
  SlackRenderIntentAction,
  SlackRenderIntentField,
  SlackRenderIntentKind,
  SummaryCardIntent,
} from "@/chat/slack/render/intents";

/**
 * Rendered view of an intent ready for Slack delivery.
 *
 * `text` is always non-empty and is the fallback shown in notifications and
 * by clients that do not render blocks. `blocks` is the Block Kit payload;
 * when absent, the intent renders as a plain mrkdwn reply.
 */
export interface SlackIntentRender {
  blocks?: SlackMessageBlock[];
  text: string;
  degradedFrom?: SlackRenderIntentKind;
  degradedTo?: SlackRenderIntentKind;
}

const SEVERITY_PREFIX: Record<AlertIntent["severity"], string> = {
  error: ":rotating_light: ",
  info: ":information_source: ",
  success: ":white_check_mark: ",
  warning: ":warning: ",
};

const PROGRESS_STATUS_ICON: Record<
  ProgressPlanIntent["tasks"][number]["status"],
  string
> = {
  complete: ":white_check_mark:",
  error: ":x:",
  in_progress: ":hourglass_flowing_sand:",
  pending: ":black_square_button:",
};

/** Render a native render intent into Slack blocks + fallback text. */
export function renderSlackIntent(
  intent: SlackRenderIntent,
): SlackIntentRender {
  switch (intent.kind) {
    case "plain_reply":
      return renderPlainReply(intent);
    case "summary_card":
      return renderSummaryCard(intent);
    case "alert":
      return renderAlert(intent);
    case "comparison_table":
      return renderComparisonTable(intent);
    case "result_carousel":
      return renderResultCarousel(intent);
    case "progress_plan":
      return renderProgressPlan(intent);
  }
}

function renderPlainReply(intent: PlainReplyIntent): SlackIntentRender {
  return { text: intent.text };
}

function renderSummaryCard(intent: SummaryCardIntent): SlackIntentRender {
  const titleLine = intent.subtitle
    ? `*${escapeSlackMrkdwnText(intent.title)}*\n_${escapeSlackMrkdwnText(intent.subtitle)}_`
    : `*${escapeSlackMrkdwnText(intent.title)}*`;

  const sectionText = intent.body
    ? `${titleLine}\n\n${intent.body}`
    : titleLine;

  const blocks: SlackMessageBlock[] = [
    {
      text: mrkdwn(sectionText),
      type: "section",
      ...(intent.fields?.length ? { fields: fieldObjects(intent.fields) } : {}),
    },
  ];

  const actions = actionsBlock(intent.actions);
  if (actions) {
    blocks.push(actions);
  }

  return {
    blocks,
    text: summaryCardFallbackText(intent),
  };
}

function renderAlert(intent: AlertIntent): SlackIntentRender {
  const prefix = SEVERITY_PREFIX[intent.severity];
  const titleLine = `${prefix}*${escapeSlackMrkdwnText(intent.title)}*`;
  const sectionText = intent.body ? `${titleLine}\n${intent.body}` : titleLine;

  const blocks: SlackMessageBlock[] = [
    { text: mrkdwn(sectionText), type: "section" },
  ];

  const actions = actionsBlock(intent.actions);
  if (actions) {
    blocks.push(actions);
  }

  return {
    blocks,
    text: alertFallbackText(intent),
  };
}

function renderComparisonTable(
  intent: ComparisonTableIntent,
): SlackIntentRender {
  const header = intent.columns
    .map((col) => `*${escapeSlackMrkdwnText(col)}*`)
    .join(" \u00b7 ");
  const rowLines = intent.rows.map((row) => {
    const cells = row.map((cell) => escapeSlackMrkdwnText(cell));
    return `\u2022 ${cells.join(" \u00b7 ")}`;
  });
  const body = [header, ...rowLines].join("\n");
  const sectionText = intent.title
    ? `*${escapeSlackMrkdwnText(intent.title)}*\n${body}`
    : body;

  return {
    blocks: [{ text: mrkdwn(sectionText), type: "section" }],
    text: comparisonTableFallbackText(intent),
  };
}

function renderResultCarousel(intent: ResultCarouselIntent): SlackIntentRender {
  const blocks: SlackMessageBlock[] = [];

  if (intent.title) {
    blocks.push({
      text: { emoji: true, text: intent.title, type: "plain_text" },
      type: "header",
    });
  }

  for (const [index, item] of intent.items.entries()) {
    if (index > 0) {
      blocks.push({ type: "divider" });
    }
    const titleLink = item.url
      ? `<${item.url}|${escapeSlackMrkdwnText(item.title)}>`
      : escapeSlackMrkdwnText(item.title);
    const titleLine = item.subtitle
      ? `*${titleLink}*\n_${escapeSlackMrkdwnText(item.subtitle)}_`
      : `*${titleLink}*`;
    const sectionText = item.body ? `${titleLine}\n${item.body}` : titleLine;
    blocks.push({
      text: mrkdwn(sectionText),
      type: "section",
      ...(item.fields?.length ? { fields: fieldObjects(item.fields) } : {}),
    });
  }

  return {
    blocks,
    text: resultCarouselFallbackText(intent),
  };
}

function renderProgressPlan(intent: ProgressPlanIntent): SlackIntentRender {
  const lines = intent.tasks.map(
    (task) =>
      `${PROGRESS_STATUS_ICON[task.status]} ${escapeSlackMrkdwnText(task.title)}`,
  );
  const sectionText = `*${escapeSlackMrkdwnText(intent.title)}*\n${lines.join("\n")}`;

  return {
    blocks: [{ text: mrkdwn(sectionText), type: "section" }],
    text: progressPlanFallbackText(intent),
  };
}

function mrkdwn(text: string): SlackMrkdwnText {
  return { text, type: "mrkdwn" };
}

function fieldObjects(
  fields: readonly SlackRenderIntentField[],
): SlackMrkdwnText[] {
  return fields.map((field) =>
    mrkdwn(
      `*${escapeSlackMrkdwnText(field.label)}*\n${escapeSlackMrkdwnText(field.value)}`,
    ),
  );
}

function actionsBlock(
  actions: readonly SlackRenderIntentAction[] | undefined,
): SlackMessageBlock | undefined {
  if (!actions?.length) {
    return undefined;
  }
  return {
    elements: actions.map((action) => ({
      text: { emoji: true, text: action.label, type: "plain_text" },
      type: "button",
      url: action.url,
    })),
    type: "actions",
  };
}

/**
 * Derive the fallback text for a rendered intent. Exported for callers that
 * need the fallback without the blocks (for example, streaming previews).
 */
export function renderIntentFallbackText(intent: SlackRenderIntent): string {
  switch (intent.kind) {
    case "plain_reply":
      return intent.text;
    case "summary_card":
      return summaryCardFallbackText(intent);
    case "alert":
      return alertFallbackText(intent);
    case "comparison_table":
      return comparisonTableFallbackText(intent);
    case "result_carousel":
      return resultCarouselFallbackText(intent);
    case "progress_plan":
      return progressPlanFallbackText(intent);
  }
}

function summaryCardFallbackText(intent: SummaryCardIntent): string {
  const lines: string[] = [intent.title];
  if (intent.subtitle) {
    lines.push(intent.subtitle);
  }
  if (intent.body) {
    lines.push(intent.body);
  }
  if (intent.fields?.length) {
    for (const field of intent.fields) {
      lines.push(`${field.label}: ${field.value}`);
    }
  }
  return lines.join("\n");
}

function alertFallbackText(intent: AlertIntent): string {
  const severityLabel = intent.severity.toUpperCase();
  const lines: string[] = [`[${severityLabel}] ${intent.title}`];
  if (intent.body) {
    lines.push(intent.body);
  }
  return lines.join("\n");
}

function comparisonTableFallbackText(intent: ComparisonTableIntent): string {
  const header = intent.columns.join(" | ");
  const rows = intent.rows.map((row) => row.join(" | "));
  const lines: string[] = [];
  if (intent.title) {
    lines.push(intent.title);
  }
  lines.push(header, ...rows);
  return lines.join("\n");
}

function resultCarouselFallbackText(intent: ResultCarouselIntent): string {
  const lines: string[] = [];
  if (intent.title) {
    lines.push(intent.title);
  }
  for (const item of intent.items) {
    const header = item.subtitle
      ? `- ${item.title} — ${item.subtitle}`
      : `- ${item.title}`;
    lines.push(header);
    if (item.body) {
      lines.push(`  ${item.body}`);
    }
  }
  return lines.join("\n");
}

function progressPlanFallbackText(intent: ProgressPlanIntent): string {
  const lines = [intent.title];
  for (const task of intent.tasks) {
    lines.push(`[${task.status}] ${task.title}`);
  }
  return lines.join("\n");
}
