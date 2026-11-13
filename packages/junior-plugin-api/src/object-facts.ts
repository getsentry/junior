import * as z from "zod";

const text = z.string().trim().min(1).max(160);
const count = z.number().int().nonnegative();

/** Small, provider-neutral facts. Missing values mean unknown, not success. */
export const objectFactsSchema = z.discriminatedUnion("type", [
  // Code changes: keep lifecycle, review, and checks separate.
  z.strictObject({
    type: z.literal("code_change"),
    author: text.optional(),
    sourceBranch: text.optional(),
    targetBranch: text.optional(),
    reviewers: z.array(text).max(5).optional(),
    review: z.enum(["required", "approved", "changes_requested"]).optional(),
    checks: z
      .strictObject({ passed: count, failed: count, pending: count })
      .optional(),
    mergeable: z.boolean().optional(),
    changedFiles: count.optional(),
    additions: count.optional(),
    deletions: count.optional(),
    /**
     * Public images from the description that the dashboard can show. The
     * 4 KiB facts limit sets how many fit.
     */
    previewImageUrls: z
      .array(z.url({ protocol: /^https?$/ }).max(512))
      .min(1)
      .optional(),
  }),
  // Tasks: ownership and priority first; planning context comes next.
  z.strictObject({
    type: z.literal("task"),
    assignees: z.array(text).max(5).optional(),
    priority: text.optional(),
    project: text.optional(),
    cycle: text.optional(),
    dueDate: z.iso.date().optional(),
    labels: z.array(text).max(5).optional(),
  }),
  // Deployments: never copy environment values or logs.
  z.strictObject({
    type: z.literal("deployment"),
    project: text.optional(),
    environment: text.optional(),
    revision: text.optional(),
    branch: text.optional(),
  }),
  // Calendar events: the owner formats the time for the requester's time zone.
  z.strictObject({
    type: z.literal("calendar_event"),
    when: text.optional(),
    attendees: z.array(text).max(5).optional(),
  }),
  // Conversations: only what the viewer may read. Never copy Messages.
  z.strictObject({
    type: z.literal("conversation"),
    participants: z.array(text).max(5).optional(),
    lastActivityAt: z.iso.datetime({ offset: true }).optional(),
  }),
  // Messages: where and when, never the text. The card description holds a
  // short snippet only for a viewer who may read the message.
  z.strictObject({
    type: z.literal("message"),
    channel: text.optional(),
    author: text.optional(),
    sentAt: z.iso.datetime({ offset: true }).optional(),
  }),
  // People: only what the dashboard People pages already show.
  z.strictObject({
    type: z.literal("person"),
    email: text.optional(),
    slackHandle: text.optional(),
    // A verified linked GitHub login. The card links it to its profile.
    // Enterprise Managed User logins have an underscore, such as `ada_acme`.
    githubHandle: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)
      .optional(),
    // A Junior photo path. Browsers never load a provider photo URL.
    avatarUrl: z
      .string()
      .max(500)
      .regex(/^\/api\/people\/avatars\/[^/?#]+(\?v=[\w-]+)?$/)
      .optional(),
  }),
]);
export type ObjectFacts = z.output<typeof objectFactsSchema>;

type ObjectField = { href?: string; key: string; label: string; value: string };

/** Show at most four card attributes, in priority order, on every surface. */
export function objectFactFields(
  facts: ObjectFacts | undefined,
): ObjectField[] {
  if (!facts) return [];
  const fields: ObjectField[] = [];
  const list = (values: string[] | undefined) =>
    values?.length
      ? `${values.join(", ")}${values.length === 5 ? " (up to 5 shown)" : ""}`
      : undefined;
  function add(
    key: string,
    label: string,
    value: string | number | undefined,
    href?: string,
  ) {
    if (value !== undefined && value !== "")
      fields.push({ key, label, value: String(value), ...(href && { href }) });
  }
  switch (facts.type) {
    case "code_change":
      // Keep cards minimal. Review, checks, and conflicts can become stale.
      add("sourceBranch", "Branch", facts.sourceBranch);
      break;
    case "task":
      add(
        "assignees",
        "Assignees",
        facts.assignees?.length === 0 ? "Unassigned" : list(facts.assignees),
      );
      add("priority", "Priority", facts.priority);
      add("project", "Project", facts.project);
      add("cycle", "Cycle", facts.cycle);
      add("dueDate", "Due", facts.dueDate);
      add("labels", "Labels", list(facts.labels));
      break;
    case "deployment":
      add("environment", "Environment", facts.environment);
      add("project", "Project", facts.project);
      add("revision", "Revision", facts.revision);
      add("branch", "Branch", facts.branch);
      break;
    case "calendar_event":
      add("when", "When", facts.when);
      add("attendees", "Attendees", list(facts.attendees));
      break;
    case "conversation":
      add("participants", "Participants", list(facts.participants));
      add(
        "lastActivityAt",
        "Last activity",
        facts.lastActivityAt &&
          new Date(facts.lastActivityAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
      );
      break;
    case "message":
      add("channel", "Channel", facts.channel);
      add("author", "Author", facts.author);
      add(
        "sentAt",
        "Sent",
        facts.sentAt &&
          new Date(facts.sentAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
      );
      break;
    case "person":
      add("email", "Email", facts.email);
      add("slackHandle", "Slack", facts.slackHandle && `@${facts.slackHandle}`);
      add(
        "githubHandle",
        "GitHub",
        facts.githubHandle && `@${facts.githubHandle}`,
        facts.githubHandle && `https://github.com/${facts.githubHandle}`,
      );
      break;
  }
  return fields.slice(0, 4);
}
