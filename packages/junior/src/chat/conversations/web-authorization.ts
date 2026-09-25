import { randomUUID } from "node:crypto";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";
import { getStateAdapter } from "@/chat/state/adapter";

const WEB_AUTHORIZATION_PREFIX = "junior:web_authorization:v1";
const WEB_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Pending web authorization saved for one Actor and Conversation. */
export interface WebAuthorizationState extends OAuthAuthorizationRequest {
  actorId: string;
  conversationId: string;
}

function authorizationKey(conversationId: string, actorId: string): string {
  return `${WEB_AUTHORIZATION_PREFIX}:${conversationId}:${actorId}`;
}

/** Build authorization delivery for one web turn. */
export function createWebAuthorization(args: {
  actorId: string;
  conversationId: string;
}) {
  return {
    createState: async () => randomUUID(),
    deliver: async (request: OAuthAuthorizationRequest) => {
      await getStateAdapter().set(
        authorizationKey(args.conversationId, args.actorId),
        JSON.stringify({ ...request, ...args } satisfies WebAuthorizationState),
        WEB_AUTHORIZATION_TTL_MS,
      );
    },
  };
}

/** Read the pending authorization request for one web actor. */
export async function getWebAuthorization(args: {
  actorId: string;
  conversationId: string;
}): Promise<WebAuthorizationState | undefined> {
  const value = await getStateAdapter().get(
    authorizationKey(args.conversationId, args.actorId),
  );
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<WebAuthorizationState>;
    if (
      parsed.actorId !== args.actorId ||
      parsed.conversationId !== args.conversationId ||
      typeof parsed.authorizationUrl !== "string" ||
      typeof parsed.label !== "string" ||
      typeof parsed.completionText !== "string"
    ) {
      return undefined;
    }
    return parsed as WebAuthorizationState;
  } catch {
    return undefined;
  }
}

/** Remove a web authorization request after the parked turn continues. */
export async function deleteWebAuthorization(args: {
  actorId: string;
  conversationId: string;
}): Promise<void> {
  await getStateAdapter().delete(
    authorizationKey(args.conversationId, args.actorId),
  );
}
