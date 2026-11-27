/**
 * Linear issue cards from hosted Linear MCP results.
 *
 * `save_issue` and `get_issue` return the same issue shape, so a saved
 * issue and a live link card show the same fields.
 */
import type {
  ObjectAnnotation,
  PluginMcpContent,
  SavedObjectAnnotation,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { LINEAR_SUBJECT_KINDS } from "./inbox-subjects.js";

const namedFact = z
  .union([z.string(), z.object({ name: z.string() })])
  .nullish();
const short = (value: string | undefined) => {
  const text = value?.trim();
  return text ? (text.length > 64 ? `${text.slice(0, 63)}…` : text) : undefined;
};
const factName = (value: z.output<typeof namedFact>) =>
  short(typeof value === "string" ? value : value?.name);

const issueIdentifier = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*-\d+$/i);
const issueSchema = z
  .object({
    identifier: issueIdentifier.optional(),
    id: z.string().optional(),
    // Linear's own id. Unlike the identifier, it stays when the issue moves
    // to another team.
    uuid: z.uuid().optional(),
    url: z.url(),
    title: z.string().optional(),
    description: z.string().nullish(),
    status: z.string().optional(),
    assignee: namedFact,
    priority: z
      .union([z.string(), z.number(), z.object({ name: z.string() })])
      .nullish(),
    project: namedFact,
    cycle: namedFact,
    labels: z.array(namedFact).nullish(),
    dueDate: z.iso.date().nullish(),
    updatedAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .transform((issue, ctx) => {
    // Hosted MCP puts the display identifier in id. A UUID is not a key.
    const identifier = issueIdentifier.safeParse(issue.identifier ?? issue.id);
    if (!identifier.success) {
      ctx.addIssue({ code: "custom", message: "Missing issue identifier" });
      return z.NEVER;
    }
    return { ...issue, identifier: identifier.data.toUpperCase() };
  });

const issueResultSchema = z.union([
  issueSchema,
  z.object({ issue: issueSchema }).transform(({ issue }) => issue),
]);

/** One Linear issue as the hosted Linear MCP returns it. */
export type LinearIssue = z.output<typeof issueSchema>;

/** Return whether a value looks like a Linear issue key, like `ENG-123`. */
export function isLinearIssueIdentifier(value: string): boolean {
  return issueIdentifier.safeParse(value).success;
}

/** Read Linear's JSON issue result without inferring issue facts from prose. */
export function readLinearIssue(result: {
  content?: PluginMcpContent[] | undefined;
  structuredContent?: unknown;
}) {
  if (result.structuredContent !== undefined) {
    return issueResultSchema.safeParse(result.structuredContent);
  }
  for (const part of result.content ?? []) {
    if (part.type !== "text") continue;
    let value: unknown;
    try {
      value = JSON.parse(part.text);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const parsed = issueResultSchema.safeParse(value);
    if (parsed.success) return parsed;
  }
  return issueResultSchema.safeParse(undefined);
}

/** Return what Junior saves for a Linear issue: subject, title, and link. */
export function linearSavedIssue(issue: LinearIssue): SavedObjectAnnotation {
  const identifier = issue.identifier;
  return {
    kind: "object",
    objectType: "task",
    key: identifier,
    // A result without the uuid keeps the identifier, as older cards do.
    subject: { id: issue.uuid ?? identifier, kind: LINEAR_SUBJECT_KINDS.issue },
    title: (issue.title || identifier).slice(0, 512),
    url: issue.url,
  };
}

/** Build the live task card of one Linear issue. */
export function linearIssueAnnotation(issue: LinearIssue): ObjectAnnotation {
  const identifier = issue.identifier;
  return {
    ...linearSavedIssue(issue),
    label: identifier,
    description: issue.description?.slice(0, 4000),
    status: issue.status,
    displayType: "Issue",
    sourceUpdatedAt: issue.updatedAt ?? undefined,
    facts: {
      type: "task",
      assignees:
        issue.assignee === undefined
          ? undefined
          : factName(issue.assignee)
            ? [factName(issue.assignee)!]
            : [],
      priority:
        typeof issue.priority === "number"
          ? ["No priority", "Urgent", "High", "Medium", "Low"][issue.priority]
          : factName(issue.priority),
      project: factName(issue.project),
      cycle: factName(issue.cycle),
      dueDate: issue.dueDate ?? undefined,
      labels: issue.labels
        ?.slice(0, 5)
        .map((label) => factName(label)!)
        .filter(Boolean),
    },
  };
}
