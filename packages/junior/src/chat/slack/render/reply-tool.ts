import { Type, type Static } from "@sinclair/typebox";
import {
  slackRenderIntentSchema,
  type SlackRenderIntent,
} from "@/chat/slack/render/intents";
import { tool } from "@/chat/tools/definition";

/**
 * Native "reply" tool.
 *
 * The agent invokes `reply` when it wants to render a richer Slack message
 * than a plain mrkdwn paragraph. The tool's input is a closed discriminated
 * union of render intents (`plain_reply` through `progress_plan`).
 *
 * This is a Renderer-style tool (not a Terminator): calling `reply` is
 * optional. Assistant turns that emit plain text still render as a
 * `plain_reply` via the existing text path. When `reply` is called, its
 * validated intent is captured onto the turn result and the renderer
 * translates it into Block Kit blocks + fallback text at delivery time.
 *
 * The intent schema exposed to the provider is defined in TypeBox (the
 * library pi-agent-core understands). The tool's execute path
 * cross-validates via Zod (`slackRenderIntentSchema`) before handing the
 * typed intent off to the capture callback — belt-and-suspenders: the
 * provider enforces structure, Zod enforces the exact same constraints the
 * renderer and tests rely on.
 */

const replyActionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 64 }),
    url: Type.String({ format: "uri", minLength: 1 }),
  },
  { additionalProperties: false },
);

const replyFieldSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 64 }),
    value: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);

const plainReplyInputSchema = Type.Object(
  {
    kind: Type.Literal("plain_reply"),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const summaryCardInputSchema = Type.Object(
  {
    actions: Type.Optional(Type.Array(replyActionSchema, { maxItems: 5 })),
    body: Type.Optional(Type.String({ maxLength: 2000 })),
    fields: Type.Optional(Type.Array(replyFieldSchema, { maxItems: 10 })),
    kind: Type.Literal("summary_card"),
    subtitle: Type.Optional(Type.String({ maxLength: 200 })),
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const alertInputSchema = Type.Object(
  {
    actions: Type.Optional(Type.Array(replyActionSchema, { maxItems: 3 })),
    body: Type.Optional(Type.String({ maxLength: 1000 })),
    kind: Type.Literal("alert"),
    severity: Type.Union([
      Type.Literal("info"),
      Type.Literal("success"),
      Type.Literal("warning"),
      Type.Literal("error"),
    ]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const comparisonTableInputSchema = Type.Object(
  {
    columns: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 6,
      minItems: 2,
    }),
    kind: Type.Literal("comparison_table"),
    rows: Type.Array(
      Type.Array(Type.String({ maxLength: 200 }), {
        maxItems: 6,
        minItems: 2,
      }),
      { maxItems: 20, minItems: 1 },
    ),
    title: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

const resultCarouselItemInputSchema = Type.Object(
  {
    body: Type.Optional(Type.String({ maxLength: 500 })),
    fields: Type.Optional(Type.Array(replyFieldSchema, { maxItems: 5 })),
    subtitle: Type.Optional(Type.String({ maxLength: 200 })),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    url: Type.Optional(Type.String({ format: "uri", minLength: 1 })),
  },
  { additionalProperties: false },
);

const resultCarouselInputSchema = Type.Object(
  {
    items: Type.Array(resultCarouselItemInputSchema, {
      maxItems: 10,
      minItems: 1,
    }),
    kind: Type.Literal("result_carousel"),
    title: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

const progressPlanTaskInputSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("complete"),
      Type.Literal("error"),
    ]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const progressPlanInputSchema = Type.Object(
  {
    kind: Type.Literal("progress_plan"),
    tasks: Type.Array(progressPlanTaskInputSchema, {
      maxItems: 20,
      minItems: 1,
    }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const replyToolInputSchema = Type.Union([
  plainReplyInputSchema,
  summaryCardInputSchema,
  alertInputSchema,
  comparisonTableInputSchema,
  resultCarouselInputSchema,
  progressPlanInputSchema,
]);

export type ReplyToolInput = Static<typeof replyToolInputSchema>;

const REPLY_TOOL_DESCRIPTION = `Render a structured Slack reply. Call this when a plain text reply would lose information the user needs to act on (e.g. returning a PR, an alert, a comparison, a multi-item result). Call with kind="plain_reply" only if you want the reply to be rendered through this tool explicitly — a turn that ends with ordinary assistant text is already rendered as plain_reply automatically.

Kinds:
- plain_reply: one mrkdwn paragraph.
- summary_card: one entity with title, optional subtitle + body, up to 10 fields, up to 5 action buttons. Best for PRs, issues, incidents, tickets, canvases.
- alert: severity-prefixed notice (info/success/warning/error) with optional body + up to 3 actions.
- comparison_table: 2-6 columns, 1-20 rows of short cells. For before/after, diff-style summaries.
- result_carousel: 1-10 items, each with title + optional subtitle/body/fields/url. For search results or multi-match responses.
- progress_plan: checklist with per-task status (pending/in_progress/complete/error).

Use sparingly. One reply call per turn. When in doubt, default to a plain text reply (no tool call).`;

export interface ReplyToolDeps {
  /**
   * Called with the validated intent when the agent invokes this tool.
   * The caller is expected to stash the intent on the turn result so that
   * delivery can render it via the renderer.
   */
  captureReplyIntent: (intent: SlackRenderIntent) => void;
}

export function createReplyTool(deps: ReplyToolDeps) {
  return tool({
    description: REPLY_TOOL_DESCRIPTION,
    inputSchema: replyToolInputSchema,
    execute: (input) => {
      // Belt-and-suspenders: the provider already enforced the TypeBox
      // schema, but we re-validate via Zod to narrow to the shared
      // SlackRenderIntent type the renderer consumes. If this ever throws
      // it means the two schemas drifted; surface it loudly.
      const intent = slackRenderIntentSchema.parse(input);
      deps.captureReplyIntent(intent);
      return {
        ok: true,
        kind: intent.kind,
      };
    },
  });
}
