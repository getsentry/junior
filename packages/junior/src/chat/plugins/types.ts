import type { UserTokenStore } from "@/chat/credentials/user-token-store";

export interface PluginOAuthConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scope?: string;
  /**
   * Set true when the provider returns an empty scope string even for authorized
   * grants (e.g. GitHub App user-to-server tokens always return `scope: ""`
   * regardless of what was requested). When enabled, an empty response scope
   * uses the configured `scope` value instead of being treated as
   * "no scopes granted".
   */
  treatEmptyScopeAsUnreported?: boolean;
  authorizeParams?: Record<string, string>;
  tokenAuthMethod?: "body" | "basic";
  tokenExtraHeaders?: Record<string, string>;
}

export interface OAuthProviderConfig extends PluginOAuthConfig {
  callbackPath: string;
}

export interface OAuthBearerCredentials {
  type: "oauth-bearer";
  domains: string[];
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
}

export type PluginCredentials = OAuthBearerCredentials;

export interface PluginNpmRuntimeDependency {
  type: "npm";
  package: string;
  version: string;
}

export interface PluginSystemRuntimeDependency {
  type: "system";
  package: string;
}

export interface PluginSystemRuntimeDependencyFromUrl {
  type: "system";
  url: string;
  sha256: string;
}

export type PluginRuntimeDependency =
  | PluginNpmRuntimeDependency
  | PluginSystemRuntimeDependency
  | PluginSystemRuntimeDependencyFromUrl;

export interface PluginRuntimePostinstallCommand {
  cmd: string;
  args?: string[];
  sudo?: boolean;
}

export interface PluginMcpHttpConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

export type PluginMcpConfig = PluginMcpHttpConfig;

export interface PluginEnvVarDeclaration {
  default?: string;
  exposeToCommandEnv?: boolean;
}

export interface PluginManifest {
  name: string;
  description: string;
  capabilities: string[];
  configKeys: string[];
  domains?: string[];
  apiHeaders?: Record<string, string>;
  commandEnv?: Record<string, string>;
  envVars?: Record<string, PluginEnvVarDeclaration>;
  credentials?: PluginCredentials;
  runtimeDependencies?: PluginRuntimeDependency[];
  runtimePostinstall?: PluginRuntimePostinstallCommand[];
  mcp?: PluginMcpConfig;
  oauth?: PluginOAuthConfig;
  target?: {
    type: string;
    configKey: string;
    commandFlags?: string[];
  };
}

type PluginRuntimeDependencyConfig =
  | {
      type: "npm";
      package: string;
      version?: string;
    }
  | {
      type: "system";
      package: string;
    }
  | {
      type: "system";
      url: string;
      sha256: string;
    };

interface PluginOAuthConfigPatch extends Omit<
  Partial<PluginOAuthConfig>,
  "authorizeParams" | "tokenExtraHeaders"
> {
  authorizeParams?: Record<string, string | null> | null;
  tokenExtraHeaders?: Record<string, string | null> | null;
}

type PluginCredentialConfigBase = {
  domains?: string[];
  authTokenEnv?: string;
  authTokenPlaceholder?: string | null;
};

type PluginCredentialConfig = PluginCredentialConfigBase & {
  apiHeaders?: Record<string, string | null> | null;
  type?: "oauth-bearer";
};

/** Install-level changes applied to one plugin manifest before validation. */
export interface PluginManifestConfig {
  description?: string;
  capabilities?: string[];
  configKeys?: string[];
  domains?: string[] | null;
  apiHeaders?: Record<string, string | null> | null;
  commandEnv?: Record<string, string | null> | null;
  envVars?: Record<string, PluginEnvVarDeclaration | null> | null;
  credentials?: PluginCredentialConfig | null;
  runtimeDependencies?: PluginRuntimeDependencyConfig[] | null;
  runtimePostinstall?: PluginRuntimePostinstallCommand[] | null;
  mcp?: {
    transport?: "http";
    url?: string;
    headers?: Record<string, string | null> | null;
    allowedTools?: string[] | null;
  } | null;
  oauth?: PluginOAuthConfigPatch | null;
  target?: {
    type?: string;
    configKey?: string;
    commandFlags?: string[] | null;
  } | null;
}

/** Install-level plugin package list and manifest override catalog. */
export interface PluginCatalogConfig {
  inlineManifests?: InlinePluginManifestDefinition[];
  packages?: string[];
  manifests?: Record<string, PluginManifestConfig>;
}

export interface PluginBrokerDeps {
  userTokenStore: UserTokenStore;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  dir: string;
  skillsDir?: string;
}

export interface InlinePluginManifestDefinition {
  manifest: PluginManifest;
  packageName?: string;
}
