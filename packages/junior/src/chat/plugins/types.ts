import type { UserTokenStore } from "@/chat/credentials/user-token-store";

export interface PluginOAuthConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scope?: string;
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

export interface GitHubAppCredentials {
  type: "github-app";
  domains: string[];
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  appIdEnv: string;
  privateKeyEnv: string;
  installationIdEnv: string;
}

export type PluginCredentials = OAuthBearerCredentials | GitHubAppCredentials;

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

/** Install-level changes applied to one plugin manifest before validation. */
export interface PluginManifestConfig {
  description?: string;
  capabilities?: string[];
  configKeys?: string[];
  domains?: string[] | null;
  apiHeaders?: Record<string, string | null> | null;
  commandEnv?: Record<string, string | null> | null;
  envVars?: Record<string, PluginEnvVarDeclaration | null> | null;
  credentials?: {
    type?: "oauth-bearer" | "github-app";
    domains?: string[];
    apiHeaders?: Record<string, string | null> | null;
    authTokenEnv?: string;
    authTokenPlaceholder?: string | null;
    appIdEnv?: string;
    privateKeyEnv?: string;
    installationIdEnv?: string;
  } | null;
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

/** Install-level plugin package list and manifest configuration. */
export interface PluginConfig {
  packages?: string[];
  manifests?: Record<string, PluginManifestConfig>;
}

export interface PluginBrokerDeps {
  userTokenStore: UserTokenStore;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  dir: string;
  skillsDir: string;
}
