/**
 * The Inbox item of an issue that Junior created. Each GitHub assignee with
 * a linked account is on it. Assigning a person on GitHub adds them, and
 * unassigning removes them. The item closes when the issue closes, is
 * deleted or transferred, or nobody is left. A dismiss unassigns the person on GitHub (`dismissGitHubItem`).
 *
 * The item belongs to the Conversation that first saved the issue's card.
 * The issue body footer names the Conversations that wrote it, and only
 * those are read. Core checks the owner from every stored card, so an edited
 * footer cannot move the item. When the footer no longer names the owner,
 * the webhook skips the item and logs it.
 */
import {
  PluginInboxItemOwnerError,
  type PluginConversationAnnotations,
  type PluginConversationInboxItems,
  type PluginLogger,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { githubConversationIds } from "../conversation-footer.js";
import { GITHUB_INBOX_SUBJECTS, issueSubject } from "../inbox-subjects.js";
import { isBotLogin } from "./ownership.js";

// A footer names a few Conversations, but a person can edit it.
const FOOTER_READ_CONCURRENCY = 4;

// A reopen does not bring a closed item back. A new assignment does.
const ITEM_ACTIONS = new Set([
  "assigned",
  "closed",
  "deleted",
  "transferred",
  "unassigned",
]);
// The issue leaves this repository, so its item closes.
const GONE_ACTIONS = new Set(["deleted", "transferred"]);

const login = z.object({ login: z.string().min(1) });

const issueEventSchema = z.object({
  action: z.string(),
  assignee: login.nullish(),
  issue: z.object({
    assignees: z.array(login).nullish(),
    body: z.string().nullish(),
    html_url: z.string(),
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    // The issues API also sends pull requests, with this field set.
    pull_request: z.unknown().optional(),
    state: z.string(),
    user: login,
  }),
});

/** One change to the assignees or the state of an issue that Junior created. */
export interface GitHubIssueItemEvent {
  /** The assignee whom this event assigned, who joins the item. */
  assigned?: string;
  assignees: string[];
  conversationIds: string[];
  issueId: string;
  number: number;
  open: boolean;
  url: string;
}

/**
 * Read an `issues` webhook that changes the item of an issue that Junior
 * created. Undefined for any other action or issue.
 */
export function normalizeGitHubIssueItemEvent(args: {
  body: unknown;
  botEmail?: string | undefined;
}): GitHubIssueItemEvent | undefined {
  const parsed = issueEventSchema.safeParse(args.body);
  if (!parsed.success || !ITEM_ACTIONS.has(parsed.data.action)) {
    return undefined;
  }
  const { action, assignee, issue } = parsed.data;
  if (issue.pull_request !== undefined) return undefined;
  if (!isBotLogin(issue.user.login, args.botEmail)) return undefined;
  const conversationIds = githubConversationIds(issue.body);
  if (conversationIds.length === 0) return undefined;
  return {
    ...(action === "assigned" && assignee
      ? { assigned: assignee.login }
      : undefined),
    assignees: (issue.assignees ?? []).map((person) => person.login),
    conversationIds,
    issueId: String(issue.id),
    number: issue.number,
    open: !GONE_ACTIONS.has(action) && issue.state === "open",
    url: issue.html_url,
  };
}

/**
 * Return the Conversation that first saved the card of the issue, among
 * the ones that its footer names. Core reads the owner the same way, from
 * every stored card.
 */
async function issueOwner(
  annotations: PluginConversationAnnotations,
  event: GitHubIssueItemEvent,
): Promise<string | undefined> {
  const saved = await pLimit(FOOTER_READ_CONCURRENCY).map(
    event.conversationIds,
    async (conversationId) => {
      const card = (
        await annotations.forConversation(conversationId).list()
      ).find(
        (annotation) =>
          annotation.kind === "object" &&
          annotation.subject?.kind === GITHUB_INBOX_SUBJECTS.issue &&
          annotation.subject.id === event.issueId,
      );
      return card ? [{ conversationId, createdAt: card.createdAt }] : [];
    },
  );
  // The earliest card wins, then the lowest id, as in core's owner query.
  // ISO timestamps and ids compare by code unit, with no locale rules.
  let first: { conversationId: string; createdAt: string } | undefined;
  for (const card of saved.flat()) {
    if (
      !first ||
      card.createdAt < first.createdAt ||
      (card.createdAt === first.createdAt &&
        card.conversationId < first.conversationId)
    ) {
      first = card;
    }
  }
  return first?.conversationId;
}

interface SyncArgs {
  annotations: PluginConversationAnnotations;
  event: GitHubIssueItemEvent;
  findLinkedIdentityIds(
    logins: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  inboxItems: PluginConversationInboxItems;
}

/** Show the item of an issue that Junior created, after an `issues` webhook. */
export async function syncGitHubIssueItem(
  args: SyncArgs & { log?: Pick<PluginLogger, "warn"> | undefined },
): Promise<void> {
  try {
    await showIssueItem(args);
  } catch (error) {
    if (!(error instanceof PluginInboxItemOwnerError)) throw error;
    args.log?.warn("GitHub issue footer does not name its item's owner", {
      "app.github.issue_id": args.event.issueId,
    });
  }
}

async function showIssueItem(args: SyncArgs): Promise<void> {
  const { event } = args;
  // An issue that Junior created before it saved the issue id on its card
  // has no owner, so it gets no item.
  const owner = await issueOwner(args.annotations, event);
  if (!owner) return;
  const items = args.inboxItems.forConversation(owner);
  const subject = issueSubject(event.issueId);
  if (!event.open) {
    await items.close({
      reason: "The issue is closed.",
      status: "done",
      subject,
    });
    return;
  }
  const linked = await args.findLinkedIdentityIds(event.assignees);
  const identityOf = (person: string) => linked.get(person.toLowerCase());
  const assigneeIdentityIds = event.assignees.flatMap(
    (person) => identityOf(person) ?? [],
  );
  if (assigneeIdentityIds.length === 0) {
    await items.close({
      reason: "Nobody on the issue has a linked account now.",
      status: "done",
      subject,
    });
    return;
  }
  const assigned = event.assigned ? identityOf(event.assigned) : undefined;
  await items.upsert({
    assigneeIdentityIds,
    askedIdentityIds: assigned ? [assigned] : [],
    // The URL stands alone, so the dashboard shows the issue as one card.
    body: `You are assigned to #${event.number}.\n\n${event.url}`,
    subject,
    title: `Assigned · #${event.number}`,
    waitsOnAssignees: true,
  });
}
