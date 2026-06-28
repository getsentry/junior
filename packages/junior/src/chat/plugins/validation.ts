import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { isDeepStrictEqual } from "node:util";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginManifest } from "@/chat/plugins/types";

/** Validate hook registrations against the loaded plugin manifest catalog. */
export function validatePluginRegistrations(
  registrations: PluginRegistration[],
): void {
  const loadedPlugins = new Map(
    pluginCatalogRuntime
      .getProviders()
      .map((plugin) => [plugin.manifest.name, plugin]),
  );

  for (const registration of registrations) {
    const loadedPlugin = loadedPlugins.get(registration.manifest.name);
    if (!loadedPlugin) {
      throw new Error(
        `Plugin registration "${registration.manifest.name}" does not have a matching plugin manifest. Add an inline manifest, packageName, or app-local plugin.yaml with the same name.`,
      );
    }
    const effectiveRegistrationManifest =
      pluginCatalogRuntime.parseConfiguredInlineManifest(
        registration.manifest as PluginManifest,
        loadedPlugin.dir,
      );
    if (
      !isDeepStrictEqual(effectiveRegistrationManifest, loadedPlugin.manifest)
    ) {
      throw new Error(
        `Plugin registration "${registration.manifest.name}" manifest does not match the loaded plugin manifest. Use one canonical manifest source for runtime hook plugins.`,
      );
    }
  }
}

/** Validate credential hook registrations against the loaded plugin manifests. */
export function validatePluginEgressCredentialHooks(
  registrations: PluginRegistration[],
): void {
  const plugins = new Map(
    registrations.map((registration) => [
      registration.manifest.name,
      registration,
    ]),
  );

  for (const provider of pluginCatalogRuntime.getProviders()) {
    const hooks = plugins.get(provider.manifest.name)?.hooks;
    const hasGrantHook = Boolean(hooks?.grantForEgress);
    const hasIssueHook = Boolean(hooks?.issueCredential);
    const hasGenericCredentials = Boolean(
      provider.manifest.credentials || provider.manifest.apiHeaders,
    );
    const hasDomains = Boolean(provider.manifest.domains?.length);
    const hasHookManagedOAuth = Boolean(
      provider.manifest.oauth && !provider.manifest.credentials,
    );
    if (!hasGrantHook && !hasIssueHook) {
      if (hasDomains && !hasGenericCredentials) {
        throw new Error(
          `Plugin "${provider.manifest.name}" manifest.domains requires egress credential hooks when no generic credentials or apiHeaders are configured.`,
        );
      }
      if (hasHookManagedOAuth) {
        throw new Error(
          `Plugin "${provider.manifest.name}" manifest.oauth without oauth-bearer credentials requires egress credential hooks.`,
        );
      }
      continue;
    }

    if (!hasGrantHook || !hasIssueHook) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks must include both grantForEgress and issueCredential.`,
      );
    }
    if (hasGenericCredentials) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks must use manifest.domains instead of generic credentials or apiHeaders.`,
      );
    }
    if (!hasDomains) {
      throw new Error(
        `Plugin "${provider.manifest.name}" egress credential hooks require manifest.domains to list sandbox egress hosts.`,
      );
    }
  }
}
