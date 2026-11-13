import * as z from "zod";

const text = z.string().trim().min(1).max(160);
const count = z.number().int().nonnegative();

// A Junior image path. Browsers never load a third-party image URL.
const imagePath = z
  .string()
  .max(4000)
  .regex(/^\/api\/images\/[\w-]+\.[\w-]+\?w=\d+(&v=[\w-]+)?$/);

/** The longest object summary, in UTF-16 code units. */
export const OBJECT_SUMMARY_MAX_LENGTH = 280;

// A short plain-text excerpt that any object type can carry. Only the full
// card shows it. Return it only to a viewer who may read the object.
const summary = z.string().trim().min(1).max(OBJECT_SUMMARY_MAX_LENGTH);

/** Small, provider-neutral facts. Missing values mean unknown, not success. */
export const objectFactsSchema = z.discriminatedUnion("type", [
  // Code changes: keep lifecycle, review, and checks separate.
  z.strictObject({
    type: z.literal("code_change"),
    summary: summary.optional(),
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
     * Images from the description. The dashboard loads them through the
     * Junior image route, and the plugin's `images` source checks each
     * viewer. The 4 KiB facts limit sets how many fit.
     */
    previewImageUrls: z
      .array(z.url({ protocol: /^https?$/ }).max(512))
      .min(1)
      .optional(),
  }),
  // Tasks: ownership and priority first; planning context comes next.
  z.strictObject({
    type: z.literal("task"),
    summary: summary.optional(),
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
    summary: summary.optional(),
    project: text.optional(),
    environment: text.optional(),
    revision: text.optional(),
    branch: text.optional(),
  }),
  // Calendar events: the owner formats the time for the requester's time zone.
  z.strictObject({
    type: z.literal("calendar_event"),
    summary: summary.optional(),
    when: text.optional(),
    attendees: z.array(text).max(5).optional(),
  }),
  // Conversations: only what the viewer may read. Never copy Messages.
  z.strictObject({
    type: z.literal("conversation"),
    summary: summary.optional(),
    participants: z.array(text).max(5).optional(),
    lastActivityAt: z.iso.datetime({ offset: true }).optional(),
  }),
  // Documents: who owns the file and when it changed. Only `summary` copies
  // text.
  z.strictObject({
    type: z.literal("document"),
    summary: summary.optional(),
    owner: text.optional(),
    modifiedAt: z.iso.datetime({ offset: true }).optional(),
    // A file thumbnail from `ObjectLinkContext.imagePath`.
    thumbnailUrl: imagePath.optional(),
  }),
  // Messages: where and when, never the text. The card description holds a
  // short snippet only for a viewer who may read the message.
  z.strictObject({
    type: z.literal("message"),
    summary: summary.optional(),
    channel: text.optional(),
    author: text.optional(),
    sentAt: z.iso.datetime({ offset: true }).optional(),
  }),
  // Public web pages: what the page or its oEmbed provider says about it.
  z.strictObject({
    type: z.literal("web_page"),
    summary: summary.optional(),
    siteName: text.optional(),
    author: text.optional(),
    thumbnailUrl: imagePath.optional(),
  }),
  // People: only what the dashboard People pages already show.
  z.strictObject({
    type: z.literal("person"),
    summary: summary.optional(),
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

/**
 * Make an object summary from plain text. Join whitespace and cut overlong
 * text at a word, with an ellipsis. Empty text gives no summary.
 */
export function objectSummary(text: string): string | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  const joined = words.join(" ");
  if (joined.length <= OBJECT_SUMMARY_MAX_LENGTH) return joined || undefined;
  let cut = "";
  for (const word of words) {
    const next = cut ? `${cut} ${word}` : word;
    if (next.length >= OBJECT_SUMMARY_MAX_LENGTH) break;
    cut = next;
  }
  // One word longer than the limit: cut inside it, not inside a surrogate pair.
  if (!cut) {
    cut = joined.slice(0, OBJECT_SUMMARY_MAX_LENGTH - 1);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

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
    case "document":
      add("owner", "Owner", facts.owner);
      add(
        "modifiedAt",
        "Modified",
        facts.modifiedAt &&
          new Date(facts.modifiedAt).toLocaleString(undefined, {
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
    case "web_page":
      add("siteName", "Site", facts.siteName);
      add("author", "Author", facts.author);
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
