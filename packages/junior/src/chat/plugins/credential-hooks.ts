import {
  agentPluginAuthorizationSchema,
  agentPluginCredentialResultSchema,
  agentPluginGrantSchema,
  type AgentPluginAuthorization,
  type AgentPluginCredentialResult,
  type AgentPluginGrant,
} from "@sentry/junior-plugin-api";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { getAgentPlugins } from "@/chat/plugins/agent-hooks";
import { createAgentPluginLogger } from "@/chat/plugins/logging";

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
): AgentPluginAuthorization | undefined {
  if (value === undefined) {
    return undefined;
  }
  const authorization = parseSchema(
    agentPluginAuthorizationSchema,
    value,
    `Trusted plugin "${pluginName}" grant authorization is invalid`,
  );
  if (authorization.provider !== pluginName) {
    throw new Error(
      `Trusted plugin "${pluginName}" grant authorization provider must match the issuing plugin`,
    );
  }
  return authorization;
}

function parseGrant(value: unknown, pluginName: string): AgentPluginGrant {
  return parseSchema(
    agentPluginGrantSchema,
    value,
    `Trusted plugin "${pluginName}" grantForEgress returned an invalid grant`,
  );
}

function parseCredentialResult(
  value: unknown,
  pluginName: string,
): AgentPluginCredentialResult {
  const result = parseSchema(
    agentPluginCredentialResultSchema,
    value,
    `Trusted plugin "${pluginName}" issueCredential result is invalid`,
  );
  if (result.type === "lease") {
    parseAuthorization(result.lease.authorization, pluginName);
    return result;
  }
  parseAuthorization(result.authorization, pluginName);
  return result;
}

export interface EgressGrantInput {
  method: string;
  provider: string;
  upstreamUrl: URL;
}

/** Ask a trusted plugin which plugin-defined grant an outbound request needs. */
export async function selectPluginGrant(
  input: EgressGrantInput,
): Promise<AgentPluginGrant | undefined> {
  const plugin = getAgentPlugins().find(
    (candidate) => candidate.name === input.provider,
  );
  const hook = plugin?.hooks?.grantForEgress;
  if (!plugin || !hook) {
    return undefined;
  }
  const result = await hook({
    plugin: { name: plugin.name },
    log: createAgentPluginLogger(plugin.name),
    request: {
      method: input.method,
      url: input.upstreamUrl.toString(),
    },
  });
  return result === undefined ? undefined : parseGrant(result, plugin.name);
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
  grant: AgentPluginGrant;
  provider: string;
  userTokenStore: UserTokenStore;
}

/** Ask a trusted plugin to issue headers or describe why the selected grant is unavailable. */
export async function issuePluginCredential(
  input: IssueCredentialInput,
): Promise<AgentPluginCredentialResult> {
  const plugin = getAgentPlugins().find(
    (candidate) => candidate.name === input.provider,
  );
  const hook = plugin?.hooks?.issueCredential;
  if (!plugin || !hook) {
    throw new Error(
      `Trusted plugin "${input.provider}" has no issueCredential hook`,
    );
  }
  const currentUserId =
    input.actor.type === "user" ? input.actor.userId : undefined;
  const credentialSubjectUserId = input.credentialSubject?.userId;
  const result = await hook({
    plugin: { name: plugin.name },
    log: createAgentPluginLogger(plugin.name),
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
