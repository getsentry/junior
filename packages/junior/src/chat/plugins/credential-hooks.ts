import { createPluginCache } from "@/chat/plugins/cache";
import {
  pluginAuthorizationSchema,
  pluginCredentialResultSchema,
  pluginGrantSchema,
  pluginProviderAccountSchema,
  type PluginAuthorization,
  type PluginCredentialActor,
  type PluginCredentialResult,
  type PluginGrant,
  type PluginProviderAccount,
  type PluginUserTokenSlot,
} from "@sentry/junior-plugin-api";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";

interface SafeSchema<T> {
  safeParse(value: unknown):
    | {
        data: T;
        success: true;
      }
    | {
        success: false;
      };
}

function parseSchema<T>(
  schema: SafeSchema<T>,
  value: unknown,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(message);
  }
  return result.data;
}

function parseAuthorization(
  value: unknown,
  pluginName: string,
): PluginAuthorization | undefined {
  if (value === undefined) {
    return undefined;
  }
  const authorization = parseSchema(
    pluginAuthorizationSchema,
    value,
    `Plugin "${pluginName}" grant authorization is invalid`,
  );
  if (authorization.provider !== pluginName) {
    throw new Error(
      `Plugin "${pluginName}" grant authorization provider must match the issuing plugin`,
    );
  }
  return authorization;
}

function parseGrant(value: unknown, pluginName: string): PluginGrant {
  return parseSchema(
    pluginGrantSchema,
    value,
    `Plugin "${pluginName}" grantForEgress returned an invalid grant`,
  );
}

function pluginFor(provider: string) {
  return getPlugins().find((candidate) => candidate.manifest.name === provider);
}

function basePluginContext(plugin: NonNullable<ReturnType<typeof pluginFor>>) {
  const pluginName = plugin.manifest.name;
  return {
    plugin: { name: pluginName },
    cache: createPluginCache(pluginName),
    log: createPluginLogger(pluginName),
    db: getDb(),
  };
}

function parseCredentialResult(
  value: unknown,
  pluginName: string,
): PluginCredentialResult {
  const result = parseSchema(
    pluginCredentialResultSchema,
    value,
    `Plugin "${pluginName}" issueCredential result is invalid`,
  );
  if (result.type === "lease") {
    parseAuthorization(result.lease.authorization, pluginName);
    return result;
  }
  if (result.type === "unavailable") {
    return result;
  }
  parseAuthorization(result.authorization, pluginName);
  return result;
}

export interface EgressGrantInput {
  bodyText?: string;
  method: string;
  operation?: string;
  provider: string;
  upstreamUrl: URL;
}

/** Ask a plugin which grant an outbound request needs. */
export async function selectPluginGrant(
  input: EgressGrantInput,
): Promise<PluginGrant | undefined> {
  const plugin = pluginFor(input.provider);
  const hook = plugin?.hooks?.grantForEgress;
  if (!plugin || !hook) {
    return undefined;
  }
  const result = await hook({
    ...basePluginContext(plugin),
    request: {
      ...(input.bodyText !== undefined
        ? { bodyText: input.bodyText }
        : undefined),
      method: input.method,
      ...(input.operation ? { operation: input.operation } : undefined),
      url: input.upstreamUrl.toString(),
    },
  });
  return result === undefined
    ? undefined
    : parseGrant(result, plugin.manifest.name);
}

export interface EgressResponseInput {
  grant: PluginGrant;
  method: string;
  operation?: string;
  provider: string;
  response: {
    headers: Headers;
    readText(maxBytes: number): Promise<string | undefined>;
    status: number;
  };
  upstreamUrl: URL;
}

export interface EgressResponseEffects {
  permissionDenied?: {
    message: string;
  };
}

/** Let the owning plugin inspect an upstream response without changing pass-through behavior. */
export async function onPluginEgressResponse(
  input: EgressResponseInput,
): Promise<EgressResponseEffects> {
  const plugin = pluginFor(input.provider);
  const hook = plugin?.hooks?.onEgressResponse;
  if (!plugin || !hook) {
    return {};
  }
  let permissionDenied: { message: string } | undefined;
  await hook({
    ...basePluginContext(plugin),
    grant: input.grant,
    permissionDenied(message) {
      const trimmed = message.trim();
      if (!trimmed) {
        throw new Error(
          `Plugin "${plugin.manifest.name}" onEgressResponse permissionDenied message is empty`,
        );
      }
      permissionDenied = { message: trimmed };
    },
    request: {
      method: input.method,
      ...(input.operation ? { operation: input.operation } : undefined),
      url: input.upstreamUrl.toString(),
    },
    response: input.response,
  });
  return permissionDenied ? { permissionDenied } : {};
}

/** Return whether a plugin owns credential issuance for egress. */
export function hasEgressCredentialHooks(provider: string): boolean {
  const hooks = pluginFor(provider)?.hooks;
  return Boolean(hooks?.grantForEgress || hooks?.issueCredential);
}

export interface IssueCredentialInput {
  actor: PluginCredentialActor;
  credentialSubject?: {
    type: "user";
    userId: string;
  };
  grant: PluginGrant;
  provider: string;
  userTokenStore: UserTokenStore;
}

/** Return providers that can verify an OAuth account for identity storage. */
export function getOAuthAccountProviders(): string[] {
  return getPlugins()
    .filter((plugin) => Boolean(plugin.hooks?.resolveOAuthAccount))
    .map((plugin) => plugin.manifest.name);
}

/** Ask a plugin which provider account belongs to an OAuth token. */
export async function resolvePluginOAuthAccount(input: {
  provider: string;
  tokenResponse: Record<string, unknown>;
  tokens: StoredTokens;
}): Promise<PluginProviderAccount | undefined> {
  const plugin = pluginFor(input.provider);
  const hook = plugin?.hooks?.resolveOAuthAccount;
  if (!plugin || !hook) {
    return undefined;
  }
  const account = await hook({
    ...basePluginContext(plugin),
    tokenResponse: input.tokenResponse,
    tokens: input.tokens,
  });
  return account === undefined
    ? undefined
    : parseSchema(
        pluginProviderAccountSchema,
        account,
        `Plugin "${plugin.manifest.name}" resolveOAuthAccount returned an invalid account`,
      );
}

// A plugin writes refreshed or enriched tokens for the grant that its last
// `get` returned. The store drops the write when the user disconnected or
// reconnected since then, so a late refresh cannot undo either one.
function userTokenSlot(
  store: UserTokenStore,
  userId: string,
  provider: string,
): PluginUserTokenSlot {
  let observed: StoredTokens | undefined;
  return {
    userId,
    get: async () => {
      observed = await store.get(userId, provider);
      return observed;
    },
    set: async (tokens) => {
      if (
        observed &&
        (await store.transition(userId, provider, {
          type: "update",
          from: observed,
          tokens,
        }))
      ) {
        observed = tokens;
      }
    },
    withRefresh: async (callback) =>
      await store.withRefresh(userId, provider, callback),
  };
}

/** Ask a plugin to issue headers or describe why the selected grant is unavailable. */
export async function issuePluginCredential(
  input: IssueCredentialInput,
): Promise<PluginCredentialResult> {
  const plugin = pluginFor(input.provider);
  const hook = plugin?.hooks?.issueCredential;
  if (!plugin || !hook) {
    throw new Error(`Plugin "${input.provider}" has no issueCredential hook`);
  }
  const currentUserId = "type" in input.actor ? input.actor.userId : undefined;
  const credentialSubjectUserId = input.credentialSubject?.userId;
  const result = await hook({
    ...basePluginContext(plugin),
    actor: input.actor,
    grant: input.grant,
    ...(input.credentialSubject
      ? { credentialSubject: input.credentialSubject }
      : undefined),
    tokens: {
      ...(currentUserId
        ? {
            currentUser: userTokenSlot(
              input.userTokenStore,
              currentUserId,
              plugin.manifest.name,
            ),
          }
        : undefined),
      ...(credentialSubjectUserId
        ? {
            credentialSubject: userTokenSlot(
              input.userTokenStore,
              credentialSubjectUserId,
              plugin.manifest.name,
            ),
          }
        : undefined),
    },
  });
  return parseCredentialResult(result, plugin.manifest.name);
}
