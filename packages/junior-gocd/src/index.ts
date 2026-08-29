/**
 * GoCD plugin runtime boundary.
 *
 * This package owns general read-only GoCD tools. The app supplies the GoCD
 * base URL and authentication. Keep deployment-specific settings in the app.
 */
import {
  defineJuniorPlugin,
  type PluginHooks,
  type PluginManifest,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { hostnameFromBaseUrl, type GocdPluginOptions } from "./config.js";
import { createGocdPipelineHistoryTool } from "./tools/pipeline-history.js";
import { createGocdStageTool } from "./tools/stage.js";

export type GocdCredentialHooks = Pick<
  PluginHooks,
  "grantForEgress" | "issueCredential" | "onEgressResponse"
>;

export interface GocdPluginRegistrationOptions extends GocdPluginOptions {
  /**
   * Optional credential hooks supplied by the app.
   * When omitted, Junior uses `GOCD_ACCESS_TOKEN` for the configured domain.
   */
  hooks?: GocdCredentialHooks;
}

function resolveManifestHostname(
  options: GocdPluginRegistrationOptions,
): string | undefined {
  const baseUrl = (options.baseUrl ?? process.env.GOCD_URL ?? "").trim();
  if (!baseUrl) return undefined;
  return hostnameFromBaseUrl(baseUrl);
}

/** Register read-only GoCD tools. */
export function gocdPlugin(
  options: GocdPluginRegistrationOptions = {},
): PluginRegistration {
  const hostname = resolveManifestHostname(options);
  const credentialHooks = options.hooks;
  const usesCredentialHooks = Boolean(
    credentialHooks?.grantForEgress || credentialHooks?.issueCredential,
  );
  const manifest: PluginManifest = {
    description: "Read GoCD pipeline and stage results",
    displayName: "GoCD",
    envVars: {
      GOCD_ACCESS_TOKEN: {},
      GOCD_URL: {},
    },
    name: "gocd",
  };
  if (hostname) {
    manifest.domains = [hostname];
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
  hostnameFromBaseUrl,
  resolveGocdApiUrl,
  resolveGocdBaseUrl,
  type GocdPluginOptions,
} from "./config.js";
