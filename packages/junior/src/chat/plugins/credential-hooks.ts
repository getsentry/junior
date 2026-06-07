import {
  agentPluginAuthorizationSchema,
  agentPluginCredentialLeaseSchema,
  agentPluginCredentialResultSchema,
  agentPluginGrantSchema,
  type AgentPluginAuthorization,
  type AgentPluginCredentialResult,
  type AgentPluginCredentialLease,
  type AgentPluginGrant,
} from "@sentry/junior-plugin-api";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { getAgentPlugins } from "@/chat/plugins/agent-hooks";
import { createAgentPluginLogger } from "@/chat/plugins/logging";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
  if (!isRecord(value)) {
    throw new Error(
      `Trusted plugin "${pluginName}" grant authorization must be an object`,
    );
  }
  if (value.type !== "oauth") {
    throw new Error(
      `Trusted plugin "${pluginName}" grant authorization has unsupported type "${String(value.type)}"`,
    );
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
  if (!isRecord(value)) {
    throw new Error(
      `Trusted plugin "${pluginName}" grantForEgress hook must return a grant object`,
    );
  }
  if (value.authorization !== undefined) {
    throw new Error(
      `Trusted plugin "${pluginName}" grantForEgress must not return authorization; return it from issueCredential when the grant is needed`,
    );
  }

  return parseSchema(
    agentPluginGrantSchema,
    value,
    `Trusted plugin "${pluginName}" grantForEgress returned an invalid grant`,
  );
}

function parseCredentialLease(
  value: unknown,
  pluginName: string,
): AgentPluginCredentialLease {
  if (!isRecord(value)) {
    throw new Error(
      `Trusted plugin "${pluginName}" issueCredential lease must be an object`,
    );
  }
  if (value.env !== undefined || value.metadata !== undefined) {
    throw new Error(
      `Trusted plugin "${pluginName}" issueCredential lease must not include unused env or metadata fields`,
    );
  }
  const lease = parseSchema(
    agentPluginCredentialLeaseSchema,
    value,
    `Trusted plugin "${pluginName}" issueCredential lease is invalid`,
  );
  return {
    ...lease,
    ...(lease.authorization
      ? { authorization: parseAuthorization(lease.authorization, pluginName) }
      : {}),
  };
}

function parseCredentialResult(
  value: unknown,
  pluginName: string,
): AgentPluginCredentialResult {
  if (!isRecord(value)) {
    throw new Error(
      `Trusted plugin "${pluginName}" issueCredential hook must return an object`,
    );
  }
  if (value.type === "needed") {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error(
        `Trusted plugin "${pluginName}" issueCredential needed result must include a message`,
      );
    }
  } else if (value.type !== "lease") {
    throw new Error(
      `Trusted plugin "${pluginName}" issueCredential result type is invalid`,
    );
  }

  const result = parseSchema(
    agentPluginCredentialResultSchema,
    value,
    `Trusted plugin "${pluginName}" issueCredential result is invalid`,
  );
  if (result.type === "lease") {
    return {
      type: "lease",
      lease: parseCredentialLease(result.lease, pluginName),
    };
  }
  return {
    type: "needed",
    message: result.message,
    ...(result.authorization
      ? { authorization: parseAuthorization(result.authorization, pluginName) }
      : {}),
  };
}

export interface EgressGrantInput {
  body: () => Promise<Uint8Array | undefined>;
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
  if (!plugin.hooks?.issueCredential) {
    throw new Error(
      `Trusted plugin "${plugin.name}" declares grantForEgress without issueCredential`,
    );
  }
  const result = await hook({
    plugin: { name: plugin.name },
    log: createAgentPluginLogger(plugin.name),
    request: {
      method: input.method,
      url: input.upstreamUrl.toString(),
      body: input.body,
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
): Promise<AgentPluginCredentialResult | undefined> {
  const plugin = getAgentPlugins().find(
    (candidate) => candidate.name === input.provider,
  );
  const hook = plugin?.hooks?.issueCredential;
  if (!plugin || !hook) {
    return undefined;
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
