export interface PluginOAuthConfig {
  authorizeEndpoint: string;
  authorizeParams?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
  /**
   * Treat a provider token response with `scope: ""` like an omitted scope and
   * fall back to the requested scope string when storing the token.
   */
  treatEmptyScopeAsUnreported?: boolean;
  tokenAuthMethod?: "body" | "basic";
  tokenEndpoint: string;
  tokenExtraHeaders?: Record<string, string>;
}

export interface PluginOAuthBearerCredentials {
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  domains: string[];
  type: "oauth-bearer";
}

export type PluginCredentials = PluginOAuthBearerCredentials;

export interface PluginNpmRuntimeDependency {
  package: string;
  type: "npm";
  version: string;
}

export interface PluginSystemRuntimeDependency {
  package: string;
  type: "system";
}

export interface PluginSystemRuntimeDependencyFromUrl {
  sha256: string;
  type: "system";
  url: string;
}

export type PluginRuntimeDependency =
  | PluginNpmRuntimeDependency
  | PluginSystemRuntimeDependency
  | PluginSystemRuntimeDependencyFromUrl;

export interface PluginRuntimePostinstallCommand {
  args?: string[];
  cmd: string;
  sudo?: boolean;
}

export interface PluginMcpConfig {
  allowedTools?: string[];
  headers?: Record<string, string>;
  transport: "http";
  url: string;
}

export interface PluginEnvVarDeclaration {
  default?: string;
  exposeToCommandEnv?: boolean;
}

export interface PluginManifest {
  apiHeaders?: Record<string, string>;
  capabilities?: string[];
  commandEnv?: Record<string, string>;
  configKeys?: string[];
  credentials?: PluginCredentials;
  description: string;
  displayName: string;
  domains?: string[];
  envVars?: Record<string, PluginEnvVarDeclaration>;
  mcp?: PluginMcpConfig;
  name: string;
  oauth?: PluginOAuthConfig;
  runtimeDependencies?: PluginRuntimeDependency[];
  runtimePostinstall?: PluginRuntimePostinstallCommand[];
  target?: {
    commandFlags?: string[];
    configKey: string;
    type: string;
  };
}
