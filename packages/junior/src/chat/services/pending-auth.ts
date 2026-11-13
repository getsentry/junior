import type { AuthorizationPauseKind } from "@/chat/services/auth-pause";
import type {
  ConversationPendingAuthState,
  ThreadConversationState,
} from "@/chat/state/conversation";
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

/**
 * Save the Conversation's sign-in wait. A Turn records the wait when it sends
 * or reuses a sign-in link, and restores the previous wait when delivery
 * fails. Only this module writes `processing.pendingAuth`.
 */
export function setPendingAuth(
  conversation: ThreadConversationState,
  pendingAuth: ConversationPendingAuthState | undefined,
): void {
  conversation.processing.pendingAuth = pendingAuth;
}

/**
 * End the sign-in wait. With `sessionId`, end it only while it belongs to
 * that Turn, so a late writer cannot end a newer wait.
 */
export function clearPendingAuth(
  conversation: ThreadConversationState,
  sessionId?: string,
): void {
  const pendingAuth = conversation.processing.pendingAuth;
  if (!pendingAuth || (sessionId && pendingAuth.sessionId !== sessionId)) {
    return;
  }
  setPendingAuth(conversation, undefined);
}

/**
 * Whether the sign-in wait is the one that a completed authorization answers:
 * the same Turn, actor, provider, kind, scope, and MCP authorization attempt.
 */
export function isPendingAuthFor(
  pendingAuth: ConversationPendingAuthState,
  authorization: {
    actorId: string;
    authSessionId?: string;
    kind: AuthorizationPauseKind;
    provider: string;
    scope?: string;
    turnId: string;
  },
): boolean {
  return (
    pendingAuth.sessionId === authorization.turnId &&
    pendingAuth.actorId === authorization.actorId &&
    pendingAuth.provider === authorization.provider &&
    pendingAuth.kind === authorization.kind &&
    pendingAuth.scope === authorization.scope &&
    (pendingAuth.kind !== "mcp" ||
      pendingAuth.authSessionId === authorization.authSessionId)
  );
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
