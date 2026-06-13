import {
  pluginAuthorizationSchema,
  pluginCredentialResultSchema,
  pluginGrantSchema,
  pluginProviderAccountSchema,
  type PluginAuthorization,
  type PluginCredentialResult,
  type PluginGrant,
  type PluginProviderAccount,
} from "@sentry/junior-plugin-api";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
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
  return getPlugins().find((candidate) => candidate.name === provider);
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
    plugin: { name: plugin.name },
    log: createPluginLogger(plugin.name),
    request: {
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      method: input.method,
      url: input.upstreamUrl.toString(),
    },
  });
  return result === undefined ? undefined : parseGrant(result, plugin.name);
}

export interface EgressResponseInput {
  grant: PluginGrant;
  method: string;
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
    plugin: { name: plugin.name },
    log: createPluginLogger(plugin.name),
    grant: input.grant,
    permissionDenied(message) {
      const trimmed = message.trim();
      if (!trimmed) {
        throw new Error(
          `Plugin "${plugin.name}" onEgressResponse permissionDenied message is empty`,
        );
      }
      permissionDenied = { message: trimmed };
    },
    request: {
      method: input.method,
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
  actor:
    | {
        type: "system";
        id: string;
      }
    | {
        type: "user";
        userId: string;
      };
  credentialSubject?: {
    type: "user";
    userId: string;
  };
  grant: PluginGrant;
  provider: string;
  userTokenStore: UserTokenStore;
}

/** Ask a plugin which provider account belongs to an OAuth token. */
export async function resolvePluginOAuthAccount(input: {
  provider: string;
  tokens: StoredTokens;
}): Promise<PluginProviderAccount | undefined> {
  const plugin = pluginFor(input.provider);
  const hook = plugin?.hooks?.resolveOAuthAccount;
  if (!plugin || !hook) {
    return undefined;
  }
  const account = await hook({
    plugin: { name: plugin.name },
    log: createPluginLogger(plugin.name),
    tokens: input.tokens,
  });
  return account === undefined
    ? undefined
    : parseSchema(
        pluginProviderAccountSchema,
        account,
        `Plugin "${plugin.name}" resolveOAuthAccount returned an invalid account`,
      );
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
  const currentUserId =
    input.actor.type === "user" ? input.actor.userId : undefined;
  const credentialSubjectUserId = input.credentialSubject?.userId;
  const result = await hook({
    plugin: { name: plugin.name },
    log: createPluginLogger(plugin.name),
    actor: input.actor,
    grant: input.grant,
    ...(input.credentialSubject
      ? { credentialSubject: input.credentialSubject }
      : {}),
    tokens: {
      ...(currentUserId
        ? {
            currentUser: {
              userId: currentUserId,
              get: async () =>
                await input.userTokenStore.get(currentUserId, plugin.name),
              set: async (tokens) => {
                await input.userTokenStore.set(
                  currentUserId,
                  plugin.name,
                  tokens,
                );
              },
            },
          }
        : {}),
      ...(credentialSubjectUserId
        ? {
            credentialSubject: {
              userId: credentialSubjectUserId,
              get: async () =>
                await input.userTokenStore.get(
                  credentialSubjectUserId,
                  plugin.name,
                ),
              set: async (tokens) => {
                await input.userTokenStore.set(
                  credentialSubjectUserId,
                  plugin.name,
                  tokens,
                );
              },
            },
          }
        : {}),
    },
  });
  return parseCredentialResult(result, plugin.name);
}
