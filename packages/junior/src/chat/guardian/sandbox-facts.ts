/**
 * What Guardian knows about the Sandbox when it reviews a shell command
 * (`placeholders` in `design/guardian.md`). Guardian judges a command, also
 * a push, from its text (`sandbox-boundary`).
 */
import type { PluginManifest } from "@sentry/junior-plugin-api";
import type { ReviewRequest } from "@/chat/guardian/guardian";

type SandboxFacts = NonNullable<ReviewRequest["sandbox"]>;

/** Credential placeholders that the installed plugins put in the Sandbox. */
export function credentialPlaceholders(
  manifests: readonly PluginManifest[],
): SandboxFacts["placeholders"] {
  return manifests.flatMap((manifest) => {
    const credentials = manifest.credentials;
    return credentials?.type === "oauth-bearer" && credentials.authTokenEnv
      ? [{ env: credentials.authTokenEnv, domains: [...credentials.domains] }]
      : [];
  });
}
