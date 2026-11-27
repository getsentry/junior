import { randomUUID } from "node:crypto";
import type {
  PluginAuthorization,
  PluginEgress,
} from "@sentry/junior-plugin-api";
import type { CredentialAuditSource } from "@/chat/credentials/audit";
import type { CredentialContext } from "@/chat/credentials/context";
import { executeCredentialedEgressRequest } from "@/chat/egress/credentialed";
import { readThroughHttpCache } from "@/chat/egress/http-cache";
import { resolveSandboxEgressProviderForHost } from "@/chat/sandbox/egress/policy";
import type { SandboxEgressCredentialContext } from "@/chat/sandbox/egress/session";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";

interface PluginEgressAuth {
  handleAuthRequired(input: {
    authorization?: PluginAuthorization;
    grant: {
      access: "read" | "write";
      name: string;
      reason?: string | undefined;
      requirements?: string[] | undefined;
    };
    kind: "auth_required" | "unavailable";
    message: string;
    provider: string;
  }): Promise<void>;
}

interface PluginEgressDeps {
  credentialAuditSource?: CredentialAuditSource;
  credentialContext?: CredentialContext | undefined;
  fetch?: typeof fetch;
  /**
   * Read GETs through Junior's HTTP cache, in entries of this egress's
   * credential context. `onStale` gets the time that an entry served after
   * its TTL was stored.
   */
  httpCache?: {
    onStale?(storedAtMs: number): void;
    staleIfError: boolean;
    ttlMs: number;
  };
  pluginAuth: PluginEgressAuth;
  /**
   * Use only the credential subject's own stored OAuth token, never a
   * plugin grant or an environment token.
   */
  userOAuthOnly?: boolean;
}

function credentialContextForPluginEgress(
  credentialContext: CredentialContext,
  source: CredentialAuditSource | undefined,
): SandboxEgressCredentialContext {
  return {
    credentials: credentialContext,
    contextId: randomUUID(),
    egressId: `plugin-egress:${randomUUID()}`,
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    source,
  };
}

/** Create host-owned provider egress for plugin runtime tools. */
export function createPluginEgress(deps: PluginEgressDeps): PluginEgress {
  const credentialContext = deps.credentialContext
    ? credentialContextForPluginEgress(
        deps.credentialContext,
        deps.credentialAuditSource,
      )
    : undefined;

  const egress: PluginEgress = {
    async fetch(input) {
      const operation = input.operation.trim();
      if (!operation) {
        throw new Error("Plugin egress operation is required");
      }
      if (!credentialContext) {
        throw new PluginCredentialFailureError(
          input.provider,
          `Cannot issue ${input.provider} credentials without a credential context.`,
        );
      }

      const upstreamUrl = new URL(input.request.url);
      if (upstreamUrl.protocol !== "https:") {
        throw new Error("Plugin egress requires HTTPS provider URLs");
      }
      const resolvedProvider = resolveSandboxEgressProviderForHost(
        upstreamUrl.hostname,
      );
      if (resolvedProvider !== input.provider) {
        throw new Error(
          `Plugin egress provider "${input.provider}" does not own ${upstreamUrl.hostname}`,
        );
      }

      const result = await executeCredentialedEgressRequest({
        activeEgressId: credentialContext.egressId,
        credentialContext,
        deps: {
          ...(deps.fetch ? { fetch: deps.fetch } : undefined),
          tracePropagation: {},
        },
        operation,
        provider: input.provider,
        request: input.request,
        upstreamUrl,
        ...(deps.userOAuthOnly ? { userOAuthOnly: true } : undefined),
      });
      if (result.authRequired) {
        await deps.pluginAuth.handleAuthRequired(result.authRequired);
      }
      return result.response;
    },
  };
  const { httpCache } = deps;
  if (!httpCache || !deps.credentialContext) return egress;
  // The credential context names the credential that egress picks, so two
  // viewers, or a viewer and the system Actor, never share an entry.
  const scope = `egress:${JSON.stringify([
    deps.credentialContext,
    deps.userOAuthOnly ? "user-oauth" : "any",
  ])}`;
  return {
    async fetch(input) {
      if (input.request.method !== "GET") return await egress.fetch(input);
      return await readThroughHttpCache({
        ...httpCache,
        request: input.request,
        scope,
        send: async (headers) => {
          const request = new Request(input.request);
          for (const [name, value] of Object.entries(headers)) {
            request.headers.set(name, value);
          }
          return await egress.fetch({ ...input, request });
        },
      });
    },
  };
}
