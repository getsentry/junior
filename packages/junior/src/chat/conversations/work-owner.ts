import type {
  Actor,
  Identity,
  PluginWorkOwner,
  User,
} from "@sentry/junior-plugin-api";
import { readRootAutomationRun } from "@/chat/automations/conversation-run";
import { readConversationRoot } from "@/chat/conversations/root";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { readIdentityById } from "@/chat/plugins/viewer";

/**
 * Read the person whose work a system Turn does: the person who asked for
 * the Conversation, else the root Actor when it is a person. A root, and a
 * child from before requesters were stored, read the root Actor. A child
 * that the system asked for does its root's work. The read by id returns
 * only user Identities, so the system Identity gives nothing.
 */
async function readRequesterIdentity(
  conversationId: string,
): Promise<{ identity: Identity; user?: User } | undefined> {
  const root = await readConversationRoot(conversationId);
  const requester = root?.requesterIdentityId
    ? await readIdentityById(root.requesterIdentityId)
    : undefined;
  if (requester) return requester;
  return root?.actorIdentityId
    ? await readIdentityById(root.actorIdentityId)
    : undefined;
}

/**
 * Resolve whose work one Turn does, for attribution only. Credentials do
 * not use it.
 *
 * The order is: the person who runs the Turn, then the person who asked for
 * the Conversation, then the root Actor when it is a person, then the system
 * record that started the root. A system Turn, such as a Watch Event, does
 * the work of who asked for its Conversation. A person who runs the Turn is
 * never replaced by someone else.
 */
export async function resolveWorkOwner(input: {
  actor?: Actor | undefined;
  conversationId: string;
  resolveActor: () => Promise<{ identity: Identity; user?: User } | undefined>;
}): Promise<PluginWorkOwner | undefined> {
  const { actor, conversationId } = input;
  if (actor && actor.platform !== "system") {
    return { kind: "person", actor, ...(await input.resolveActor()) };
  }
  const requester = await readRequesterIdentity(conversationId);
  if (requester) return { kind: "person", ...requester };
  // Each system record that can own work is read here, so plugins never
  // branch on what started it.
  const run = await readRootAutomationRun(conversationId);
  if (!run) return undefined;
  const url = getDashboardTaskLink(run.automationId);
  return {
    kind: "system",
    name: "automation",
    id: run.automationId,
    ...(run.automationRunId ? { runId: run.automationRunId } : undefined),
    ...(url ? { url } : undefined),
  };
}
