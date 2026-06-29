import { randomUUID } from "node:crypto";
import type {
  PluginAuthorization,
  PluginEgress,
} from "@sentry/junior-plugin-api";
import type { CredentialContext } from "@/chat/credentials/context";
import { executeCredentialedEgressRequest } from "@/chat/egress/credentialed";
import { resolveSandboxEgressProviderForHost } from "@/chat/sandbox/egress/policy";
import type { SandboxEgressCredentialContext } from "@/chat/sandbox/egress/session";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";

interface PluginEgressAuth {
  handleAuthRequired(input: {
    authorization?: PluginAuthorization;
    grant: {
      access: "read" | "write";
      name: string;
      reason?: string;
      requirements?: string[];
    };
    kind: "auth_required" | "unavailable";
    message: string;
    provider: string;
  }): Promise<void>;
}

interface PluginEgressDeps {
  credentialContext?: CredentialContext;
  fetch?: typeof fetch;
  pluginAuth: PluginEgressAuth;
}

function credentialContextForPluginEgress(
  credentialContext: CredentialContext,
): SandboxEgressCredentialContext {
  return {
    credentials: credentialContext,
    contextId: randomUUID(),
    egressId: `plugin-egress:${randomUUID()}`,
    expiresAtMs: Date.now() + 30 * 60 * 1000,
  };
}

/** Create host-owned provider egress for plugin runtime tools. */
export function createPluginEgress(deps: PluginEgressDeps): PluginEgress {
  const credentialContext = deps.credentialContext
    ? credentialContextForPluginEgress(deps.credentialContext)
    : undefined;

  return {
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

      return await executeCredentialedEgressRequest({
        activeEgressId: credentialContext.egressId,
        credentialContext,
        deps: {
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          recordAuthRequired: async (signal) => {
            await deps.pluginAuth.handleAuthRequired({
              ...(signal.authorization
                ? { authorization: signal.authorization }
                : {}),
              grant: signal.grant,
              kind: signal.kind ?? "auth_required",
              message: signal.message,
              provider: signal.provider,
            });
          },
          recordPermissionDenied: async () => {},
          tracePropagation: {},
        },
        operation,
        provider: input.provider,
        request: input.request,
        upstreamUrl,
      });
    },
  };
}
