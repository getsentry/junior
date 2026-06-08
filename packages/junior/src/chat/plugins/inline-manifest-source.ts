import type { PluginManifest } from "./types";

type ManifestSource = Record<string, unknown>;

function setDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unqualifyManifestToken(name: unknown, value: unknown): unknown {
  if (
    typeof name === "string" &&
    typeof value === "string" &&
    value.startsWith(`${name}.`)
  ) {
    return value.slice(name.length + 1);
  }
  return value;
}

function inlineTokenListSource(name: unknown, values: unknown): unknown {
  if (values === undefined || !Array.isArray(values)) {
    return values;
  }
  return values.map((value) => unqualifyManifestToken(name, value));
}

function inlineCredentialsSource(
  credentials: PluginManifest["credentials"],
): unknown {
  if (credentials === undefined || !isRecord(credentials)) {
    return credentials;
  }

  const result: ManifestSource = {};
  setDefined(result, "type", credentials.type);
  setDefined(result, "domains", credentials.domains);
  setDefined(result, "api-headers", credentials.apiHeaders);
  setDefined(result, "auth-token-env", credentials.authTokenEnv);
  setDefined(
    result,
    "auth-token-placeholder",
    credentials.authTokenPlaceholder,
  );
  return result;
}

function inlineMcpSource(mcp: PluginManifest["mcp"]): unknown {
  if (mcp === undefined || !isRecord(mcp)) {
    return mcp;
  }

  const result: ManifestSource = {};
  setDefined(result, "transport", mcp.transport);
  setDefined(result, "url", mcp.url);
  setDefined(result, "headers", mcp.headers);
  setDefined(result, "allowed-tools", mcp.allowedTools);
  return result;
}

function inlineOauthSource(oauth: PluginManifest["oauth"]): unknown {
  if (oauth === undefined || !isRecord(oauth)) {
    return oauth;
  }

  const result: ManifestSource = {};
  setDefined(result, "client-id-env", oauth.clientIdEnv);
  setDefined(result, "client-secret-env", oauth.clientSecretEnv);
  setDefined(result, "authorize-endpoint", oauth.authorizeEndpoint);
  setDefined(result, "token-endpoint", oauth.tokenEndpoint);
  setDefined(result, "scope", oauth.scope);
  setDefined(result, "authorize-params", oauth.authorizeParams);
  setDefined(result, "token-auth-method", oauth.tokenAuthMethod);
  setDefined(result, "token-extra-headers", oauth.tokenExtraHeaders);
  setDefined(
    result,
    "treat-empty-scope-as-unreported",
    oauth.treatEmptyScopeAsUnreported,
  );
  return result;
}

function inlineTargetSource(
  name: unknown,
  target: PluginManifest["target"],
): unknown {
  if (target === undefined || !isRecord(target)) {
    return target;
  }

  const result: ManifestSource = {};
  setDefined(result, "type", target.type);
  setDefined(
    result,
    "config-key",
    unqualifyManifestToken(name, target.configKey),
  );
  setDefined(result, "command-flags", target.commandFlags);
  return result;
}

/** Convert inline JavaScript plugin manifests to the canonical source shape. */
export function inlineManifestSource(manifest: PluginManifest): ManifestSource {
  const result: ManifestSource = {};

  setDefined(result, "name", manifest.name);
  setDefined(result, "description", manifest.description);
  setDefined(
    result,
    "capabilities",
    inlineTokenListSource(manifest.name, manifest.capabilities),
  );
  setDefined(
    result,
    "config-keys",
    inlineTokenListSource(manifest.name, manifest.configKeys),
  );
  setDefined(result, "domains", manifest.domains);
  setDefined(result, "api-headers", manifest.apiHeaders);
  setDefined(result, "command-env", manifest.commandEnv);
  setDefined(result, "env-vars", manifest.envVars);
  setDefined(
    result,
    "credentials",
    inlineCredentialsSource(manifest.credentials),
  );
  setDefined(result, "runtime-dependencies", manifest.runtimeDependencies);
  setDefined(result, "runtime-postinstall", manifest.runtimePostinstall);
  setDefined(result, "mcp", inlineMcpSource(manifest.mcp));
  setDefined(result, "oauth", inlineOauthSource(manifest.oauth));
  setDefined(
    result,
    "target",
    inlineTargetSource(manifest.name, manifest.target),
  );
  return result;
}
