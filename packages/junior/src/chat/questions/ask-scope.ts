import type { User } from "@sentry/junior-plugin-api";
import {
  readConversationAccessFromSql,
  type ProviderTenant,
} from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import {
  automationCreatorUserId,
  conversationParticipantUserIds,
  type ResolvedAssignees,
} from "./assignees";

/** The Turn context that the scope of an ask reads. */
export type AskScopeContext = Pick<
  ToolRuntimeContext,
  "actorIsApp" | "conversationId" | "resolveActorIdentity" | "source"
>;

/** Who asks, and from which Conversation. */
export interface AskScope {
  /**
   * Whether the Actor of the Turn is a person. A system Actor, such as the
   * Actor of an event Turn, is not, and an app Actor is not.
   */
  actorIsPerson: boolean;
  /** User of an app Actor. An app is not a person, so nobody asks it. */
  appUserId?: string;
  /** The Automation of this run, which can change what its runs asked. */
  automationId?: string;
  /** Whether the current Conversation is not public. */
  inPrivateConversation: boolean;
  /** Provider tenant of the current Conversation. */
  tenant?: ProviderTenant;
  user?: User;
}

/** Read who asks, from the Turn's Actor, Source, and Conversation. */
export async function readAskScope(
  context: AskScopeContext,
): Promise<AskScope> {
  // Only a user Identity resolves, so a system Actor has none. An app can
  // have a user Identity and a User, but it is not a person.
  const resolved = await context.resolveActorIdentity?.();
  const actor = context.actorIsApp ? undefined : resolved;
  const appUserId = context.actorIsApp ? resolved?.user?.id : undefined;
  const user = actor?.user;
  const automationId =
    context.source.kind === "scheduled_automation" ||
    context.source.kind === "event_automation"
      ? context.source.automationId
      : undefined;
  const current = (
    await readConversationAccessFromSql(getDb(), [context.conversationId], user)
  ).get(context.conversationId);
  const tenant = current?.tenant;
  return {
    actorIsPerson: actor !== undefined,
    ...(appUserId ? { appUserId } : undefined),
    ...(automationId ? { automationId } : undefined),
    inPrivateConversation: current?.visibility !== "public",
    ...(tenant ? { tenant } : undefined),
    ...(user ? { user } : undefined),
  };
}

/**
 * Check who a private question asks. It cannot ask Everyone yet: the old
 * visibility check stays for the release before this one (migration
 * `20261126154025_inbox_item_owners`), and a later release lets it go to the
 * people who can see its owner (`inboxItemForEveryoneOfOwner`). Each User
 * must be the current Actor, a Participant of one of the given
 * Conversations (the current one and, for an existing question, the one
 * that asked it), or the creator of the Automation that asked it. An
 * Automation run often has no Actor and no people yet, and its creator wrote
 * the work. A public question can ask anyone.
 */
export async function requireAskedPeople(args: {
  assignees: ResolvedAssignees;
  automationId: string | undefined;
  conversationIds: readonly string[];
  isPrivate: boolean;
  user: User | undefined;
}): Promise<void> {
  if (!args.isPrivate) return;
  if (args.assignees.everyone) {
    throw new ToolInputError(
      "A private item cannot be assigned to Everyone. Assign Users instead.",
    );
  }
  const creatorId = args.automationId
    ? await automationCreatorUserId(getDb(), args.automationId)
    : undefined;
  const others = args.assignees.userIds.filter(
    (id) => id !== args.user?.id && id !== creatorId,
  );
  const inConversation = await conversationParticipantUserIds(
    getDb(),
    args.conversationIds,
    others,
  );
  if (others.some((id) => !inConversation.has(id))) {
    throw new ToolInputError(
      "A private item can be assigned only to people in its Conversation. Remove the other people from `assignees`.",
    );
  }
}
