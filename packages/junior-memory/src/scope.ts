import { isPrivateSource, type Identity } from "@sentry/junior-plugin-api";
import type {
  MemoryRuntimeContext,
  MemoryScope,
  MemorySubjectType,
} from "./types";

/** Runtime-derived visibility scope used for memory authorization checks. */
export interface ResolvedMemoryScope {
  scope: MemoryScope;
  scopeKey: string;
}

/** Runtime-derived subject classification stored for filtering and rendering. */
export interface ResolvedMemorySubject {
  subjectKey?: string;
  subjectType: MemorySubjectType;
}

/** Viewer-authorized personal, workspace, and publish-target scopes. */
export interface ViewerMemoryScopes {
  privateScopes: ResolvedMemoryScope[];
  publicScopes: ResolvedMemoryScope[];
  workspaceScopesByPrivateKey: ReadonlyMap<string, ResolvedMemoryScope>;
}

type MemoryIdentity = Pick<
  Identity,
  "provider" | "providerSubjectId" | "providerTenantId"
>;

function uniqueScopes(scopes: ResolvedMemoryScope[]): ResolvedMemoryScope[] {
  return [
    ...new Map(
      scopes.map((scope) => [`${scope.scope}:${scope.scopeKey}`, scope]),
    ).values(),
  ];
}

/** Build the personal scope key for one provider identity. */
export function identityScopeKey(identity: MemoryIdentity): string {
  return identity.providerTenantId
    ? `${identity.provider}:${identity.providerTenantId}:${identity.providerSubjectId}`
    : `${identity.provider}:${identity.providerSubjectId}`;
}

function workspaceScope(identity: MemoryIdentity) {
  if (!identity.providerTenantId) return undefined;
  return {
    scope: "conversation" as const,
    scopeKey: `${identity.provider}:${identity.providerTenantId}`,
  };
}

/** Derive viewer-visible memory scopes from canonical provider identities. */
export function deriveViewerMemoryScopes(
  identities: Identity[],
): ViewerMemoryScopes {
  const privateScopes = identities.map((identity) => ({
    scope: "personal" as const,
    scopeKey: identityScopeKey(identity),
  }));
  const publicScopes = identities.flatMap((identity) => {
    const scope = workspaceScope(identity);
    return scope ? [scope] : [];
  });
  const workspaceScopesByPrivateKey = new Map<string, ResolvedMemoryScope>();
  for (const identity of identities) {
    const scope = workspaceScope(identity);
    if (scope) {
      workspaceScopesByPrivateKey.set(identityScopeKey(identity), scope);
    }
  }
  return {
    privateScopes: uniqueScopes(privateScopes),
    publicScopes: uniqueScopes(publicScopes),
    workspaceScopesByPrivateKey,
  };
}

function sourceConversationKey(ctx: MemoryRuntimeContext): string | undefined {
  if (ctx.source.platform === "local") {
    return ctx.source.conversationId;
  }
  if (!isPrivateSource(ctx.source)) {
    return `slack:${ctx.source.teamId}`;
  }
  const threadKey = ctx.source.threadTs ?? ctx.source.messageTs;
  if (!threadKey) {
    return undefined;
  }
  return `slack:${ctx.source.teamId}:${ctx.source.channelId}:${threadKey}`;
}

function actorScopeKey(ctx: MemoryRuntimeContext): string | undefined {
  const actor = ctx.actor;
  if (!actor?.userId) {
    return undefined;
  }
  if (actor.platform === "slack") {
    return identityScopeKey({
      provider: actor.platform,
      providerTenantId: actor.teamId,
      providerSubjectId: actor.userId,
    });
  }
  return identityScopeKey({
    provider: actor.platform,
    providerSubjectId: actor.userId,
  });
}

/** Derive the authority-bearing key for a requested memory scope. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
  scope: MemoryScope,
): ResolvedMemoryScope {
  if (scope === "personal") {
    const scopeKey = actorScopeKey(ctx);
    if (!scopeKey) {
      throw new Error("Personal memory requires actor context.");
    }
    return { scope, scopeKey };
  }

  const scopeKey = sourceConversationKey(ctx);
  if (!scopeKey) {
    throw new Error("Conversation memory requires conversation context.");
  }
  return { scope, scopeKey };
}

/** Derive the memory subject from the already-authorized write scope. */
export function deriveMemorySubject(
  ctx: MemoryRuntimeContext,
  scope: ResolvedMemoryScope,
): ResolvedMemorySubject {
  if (scope.scope === "personal") {
    const subjectKey = actorScopeKey(ctx);
    if (!subjectKey) {
      throw new Error("User-subject memory requires actor context.");
    }
    return { subjectType: "user", subjectKey };
  }

  const subjectKey = sourceConversationKey(ctx);
  if (!subjectKey) {
    throw new Error(
      "Conversation-subject memory requires conversation context.",
    );
  }
  return { subjectType: "conversation", subjectKey };
}

/** Return every visible scope for memory retrieval in the current context. */
export function deriveVisibleMemoryScopes(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope[] {
  const scopes: ResolvedMemoryScope[] = [];
  try {
    scopes.push(deriveMemoryScope(ctx, "personal"));
  } catch {
    // Personal memory is optional when a runtime surface has no actor.
  }
  try {
    scopes.push(deriveMemoryScope(ctx, "conversation"));
  } catch {
    // Conversation memory is optional for synthetic invocations.
  }
  return scopes;
}
