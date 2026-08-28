/**
 * GoCD plugin runtime boundary.
 *
 * This package owns generic read-only GoCD tools. Host deployments supply the
 * GoCD base URL and inject authentication at Junior egress. Do not put
 * environment-specific deploy topology or private host defaults here.
 */
import {
  defineJuniorPlugin,
  type PluginHooks,
  type PluginManifest,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { hostFromBaseUrl, type GocdPluginOptions } from "./config.js";
import { createGocdPipelineHistoryTool } from "./tools/pipeline-history.js";
import { createGocdStageTool } from "./tools/stage.js";

export type GocdCredentialHooks = Pick<
  PluginHooks,
  "grantForEgress" | "issueCredential" | "onEgressResponse"
>;

export interface GocdPluginRegistrationOptions extends GocdPluginOptions {
  /**
   * Optional host-owned egress credential hooks.
   * When set, the plugin declares domains only and lets the host mint headers.
   * When omitted and a host is known, static bearer `apiHeaders` are used.
   */
  hooks?: GocdCredentialHooks;
}

function resolveManifestHost(
  options: GocdPluginRegistrationOptions,
): string | undefined {
  const baseUrl = (options.baseUrl ?? process.env.GOCD_URL ?? "").trim();
  if (!baseUrl) return undefined;
  return hostFromBaseUrl(baseUrl);
}

/** Register read-only GoCD tools that authenticate through Junior egress. */
export function gocdPlugin(
  options: GocdPluginRegistrationOptions = {},
): PluginRegistration {
  const host = resolveManifestHost(options);
  const credentialHooks = options.hooks;
  const usesCredentialHooks = Boolean(
    credentialHooks?.grantForEgress || credentialHooks?.issueCredential,
  );
  const manifest: PluginManifest = {
    description:
      "Query GoCD pipeline history through host-managed egress credentials",
    displayName: "GoCD",
    envVars: {
      GOCD_ACCESS_TOKEN: {},
      GOCD_URL: {},
    },
    name: "gocd",
  };
  if (host) {
    manifest.domains = [host];
    if (!usesCredentialHooks) {
      manifest.apiHeaders = {
        Authorization: "bearer ${GOCD_ACCESS_TOKEN}",
      };
    }
  }
  const hooks: PluginHooks = {
    tools(ctx) {
      return {
        pipelineHistory: createGocdPipelineHistoryTool(ctx, options),
        stage: createGocdStageTool(ctx, options),
      };
    },
  };
  if (credentialHooks?.grantForEgress) {
    hooks.grantForEgress = credentialHooks.grantForEgress;
  }
  if (credentialHooks?.issueCredential) {
    hooks.issueCredential = credentialHooks.issueCredential;
  }
  if (credentialHooks?.onEgressResponse) {
    hooks.onEgressResponse = credentialHooks.onEgressResponse;
  }

  return defineJuniorPlugin({
    packageName: "@sentry/junior-gocd",
    manifest,
    hooks,
  });
}

export {
  hostFromBaseUrl,
  resolveGocdApiUrl,
  resolveGocdTarget,
  type GocdPluginOptions,
  type ResolvedGocdTarget,
} from "./config.js";
