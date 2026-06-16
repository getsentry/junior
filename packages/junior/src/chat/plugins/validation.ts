import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { getPluginProviders } from "@/chat/plugins/registry";

/** Validate hook registrations against the loaded plugin manifest catalog. */
export function validatePluginRegistrations(
  registrations: PluginRegistration[],
): void {
  const loadedPlugins = getPluginProviders();
  const loadedNames = new Set(
    loadedPlugins.map((plugin) => plugin.manifest.name),
  );

  for (const registration of registrations) {
    if (!loadedNames.has(registration.manifest.name)) {
      throw new Error(
        `Plugin registration "${registration.manifest.name}" does not have a matching plugin manifest. Add an inline manifest, packageName, or app-local plugin.yaml with the same name.`,
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

  for (const provider of getPluginProviders()) {
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
