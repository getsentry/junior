import { formatProviderLabel } from "@/chat/oauth-flow";
import type {
  AuthorizationPauseDisposition,
  AuthorizationPauseKind,
} from "@/chat/services/auth-pause";
import type {
  ConversationPendingAuthState,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { supersedeAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";

// A fresh private auth link is worth reissuing after ~10 minutes: long enough
// to cover normal back-and-forth (read the prompt, check a password manager),
// short enough that a link the user has clearly abandoned doesn't keep
// re-advertising itself. Most provider `state` TTLs sit above this window,
// so the old link is usually still honorable when we reuse it.
const AUTH_LINK_REUSE_WINDOW_MS = 10 * 60 * 1000;

export function canReusePendingAuthLink(args: {
  kind: AuthorizationPauseKind;
  nowMs?: number;
  pendingAuth?: ConversationPendingAuthState;
  provider: string;
  requesterId: string;
}): boolean {
  const { pendingAuth } = args;
  if (!pendingAuth) {
    return false;
  }

  return (
    pendingAuth.kind === args.kind &&
    pendingAuth.provider === args.provider &&
    pendingAuth.requesterId === args.requesterId &&
    pendingAuth.linkSentAtMs + AUTH_LINK_REUSE_WINDOW_MS >
      (args.nowMs ?? Date.now())
  );
}

export function buildAuthPauseReplyText(args: {
  disposition?: AuthorizationPauseDisposition;
  provider?: string;
}): string {
  const providerLabel = args.provider ? formatProviderLabel(args.provider) : "";
  if (args.disposition === "link_already_sent") {
    return providerLabel
      ? `I still need your ${providerLabel} access to continue. I already sent you a private link.`
      : "I still need additional access to continue. I already sent you a private link.";
  }

  return providerLabel
    ? `I need your ${providerLabel} access to continue. I sent you a private link.`
    : "I need additional access to continue. I sent you a private link.";
}

export function getConversationPendingAuth(args: {
  conversation: ThreadConversationState;
  kind: AuthorizationPauseKind;
  provider: string;
  requesterId: string;
}): ConversationPendingAuthState | undefined {
  const pendingAuth = args.conversation.processing.pendingAuth;
  if (!pendingAuth) {
    return undefined;
  }
  if (
    pendingAuth.kind !== args.kind ||
    pendingAuth.provider !== args.provider ||
    pendingAuth.requesterId !== args.requesterId
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

/**
 * Apply a new pending-auth record to the conversation and, when replacing a
 * different session's pending-auth, mark the prior checkpoint as superseded.
 * Callers are responsible for persisting the mutated conversation afterwards.
 */
export async function applyPendingAuthUpdate(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
  nextPendingAuth: ConversationPendingAuthState;
}): Promise<void> {
  const previousPendingAuth = args.conversation.processing.pendingAuth;
  args.conversation.processing.pendingAuth = args.nextPendingAuth;
  if (
    previousPendingAuth &&
    previousPendingAuth.sessionId !== args.nextPendingAuth.sessionId &&
    args.conversationId
  ) {
    await supersedeAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
      sessionId: previousPendingAuth.sessionId,
      errorMessage:
        "Superseded by a newer auth-blocked request in the same conversation.",
    });
  }
}

export function isPendingAuthLatestRequest(
  conversation: ThreadConversationState,
  pendingAuth: ConversationPendingAuthState,
): boolean {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    return buildDeterministicTurnId(message.id) === pendingAuth.sessionId;
  }

  return false;
}
