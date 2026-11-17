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
 * Read the root Actor of a Conversation tree when it is a person. A root
 * that the system started has the system Identity, so it gives nothing.
 */
async function readRootActorIdentity(
  conversationId: string,
): Promise<{ identity: Identity; user?: User } | undefined> {
  const root = await readConversationRoot(conversationId);
  // The read by id returns only user Identities.
  return root?.actorIdentityId
    ? await readIdentityById(root.actorIdentityId)
    : undefined;
}

/**
 * Resolve whose work one Turn does, for attribution only. Credentials do
 * not use it.
 *
 * The order is: the person who runs the Turn, then the root Actor when it is
 * a person, then the system record that started the root. A system Turn,
 * such as a Watch Event or a parent agent's message, does its root's work.
 * A person who runs the Turn is never replaced by someone else.
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
  const root = await readRootActorIdentity(conversationId);
  if (root) return { kind: "person", ...root };
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
