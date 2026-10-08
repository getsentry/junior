import type { AuthorizationPauseKind } from "@/chat/services/auth-pause";
import { SubscribedReplyReason } from "@/chat/services/subscribed-decision";
import type {
  ConversationPendingAuthState,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { abandonTurnRecord } from "@/chat/task-execution/checkpoint";

// A fresh private auth link is worth reissuing after ~10 minutes: long enough
// to cover normal back-and-forth (read the prompt, check a password manager),
// short enough that a link the user has clearly abandoned doesn't keep
// re-advertising itself. Most provider `state` TTLs sit above this window,
// so the old link is usually still honorable when we reuse it.
const AUTH_LINK_REUSE_WINDOW_MS = 10 * 60 * 1000;

/** Decide whether the same agent-run session can reuse its fresh auth link. */
export function canReusePendingAuthLink(args: {
  kind: AuthorizationPauseKind;
  nowMs?: number;
  pendingAuth?: ConversationPendingAuthState;
  provider: string;
  actorId: string;
  scope?: string;
  sessionId: string;
}): boolean {
  const { pendingAuth } = args;
  if (!pendingAuth) {
    return false;
  }

  return (
    pendingAuth.kind === args.kind &&
    pendingAuth.provider === args.provider &&
    pendingAuth.actorId === args.actorId &&
    pendingAuth.scope === args.scope &&
    pendingAuth.sessionId === args.sessionId &&
    pendingAuth.linkSentAtMs + AUTH_LINK_REUSE_WINDOW_MS >
      (args.nowMs ?? Date.now())
  );
}

/** Return the exact pending authorization target for one actor and provider. */
export function getConversationPendingAuth(args: {
  conversation: ThreadConversationState;
  kind: "mcp";
  provider: string;
  actorId: string;
  scope?: string;
}): Extract<ConversationPendingAuthState, { kind: "mcp" }> | undefined;
export function getConversationPendingAuth(args: {
  conversation: ThreadConversationState;
  kind: "plugin";
  provider: string;
  actorId: string;
  scope?: string;
}): Extract<ConversationPendingAuthState, { kind: "plugin" }> | undefined;
export function getConversationPendingAuth(args: {
  conversation: ThreadConversationState;
  kind: AuthorizationPauseKind;
  provider: string;
  actorId: string;
  scope?: string;
}): ConversationPendingAuthState | undefined {
  const pendingAuth = args.conversation.processing.pendingAuth;
  if (!pendingAuth) {
    return undefined;
  }
  if (
    pendingAuth.kind !== args.kind ||
    pendingAuth.provider !== args.provider ||
    pendingAuth.actorId !== args.actorId ||
    pendingAuth.scope !== args.scope
  ) {
    return undefined;
  }
  return pendingAuth;
}

export function clearPendingAuth(
  conversation: ThreadConversationState,
  sessionId?: string,
): void {
  if (!conversation.processing.pendingAuth) {
    return;
  }
  if (
    sessionId &&
    conversation.processing.pendingAuth.sessionId !== sessionId
  ) {
    return;
  }
  conversation.processing.pendingAuth = undefined;
}

/** Mark the prior blocked turn abandoned after a new auth attempt replaces it. */
export async function abandonReplacedPendingAuth(args: {
  conversationId: string | undefined;
  previousPendingAuth: ConversationPendingAuthState | undefined;
  nextPendingAuth: ConversationPendingAuthState;
}): Promise<void> {
  if (
    args.previousPendingAuth &&
    args.previousPendingAuth.sessionId !== args.nextPendingAuth.sessionId &&
    args.conversationId
  ) {
    await abandonTurnRecord({
      conversationId: args.conversationId,
      turnId: args.previousPendingAuth.sessionId,
      errorMessage:
        "Abandoned by a newer auth-blocked request in the same conversation.",
    });
  }
}

/**
 * Whether the person told Junior to stop after the request that waits for
 * authorization. No other later message ends the wait: the agent reads the
 * thread when the authorization resumes the request, and it decides whether
 * the request is still wanted.
 */
export function wasPendingAuthStopped(
  conversation: ThreadConversationState,
  pendingAuth: ConversationPendingAuthState,
): boolean {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (buildDeterministicTurnId(message.id) === pendingAuth.sessionId) {
      return false;
    }
    if (
      message.meta?.skippedReason?.startsWith(
        `${SubscribedReplyReason.ThreadOptOut}:`,
      )
    ) {
      return true;
    }
  }

  return false;
}
