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
  apiDomains: string[];
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
}

export interface GitHubAppCredentials {
  type: "github-app";
  apiDomains: string[];
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

export interface CardFieldSchema {
  type: "string" | "integer" | "boolean";
  required?: boolean;
  description?: string;
  enum?: string[];
}

export interface CardRenderField {
  label: string;
  value: string;
  fallback?: string;
}

export interface CardRenderTemplate {
  title: string;
  titleUrl?: string;
  body?: string;
  linkLabel?: string;
  status?: {
    text: string;
    styleMap?: Record<string, "success" | "warning" | "danger" | "default">;
  };
  fields?: CardRenderField[];
  fallbackText: string;
}

export interface PluginCardDeclaration {
  name: string;
  description: string;
  entityKey: string;
  schema: Record<string, CardFieldSchema>;
  render: CardRenderTemplate;
}

export interface PluginManifest {
  name: string;
  description: string;
  capabilities: string[];
  configKeys: string[];
  credentials?: PluginCredentials;
  runtimeDependencies?: PluginRuntimeDependency[];
  runtimePostinstall?: PluginRuntimePostinstallCommand[];
  cards?: PluginCardDeclaration[];
  mcp?: PluginMcpConfig;
  oauth?: PluginOAuthConfig;
  target?: {
    type: "repo";
    configKey: string;
  };
}

export interface PluginBrokerDeps {
  userTokenStore: UserTokenStore;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  dir: string;
  skillsDir: string;
}
