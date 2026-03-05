import type { UserTokenStore } from "@/chat/credentials/user-token-store";

export interface OAuthBearerCredentials {
  type: "oauth-bearer";
  apiDomains: string[];
  authTokenEnv: string;
  authTokenPlaceholder?: string;
}

export interface GitHubAppCredentials {
  type: "github-app";
  apiDomains: string[];
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  appIdEnv: string;
  privateKeyEnv: string;
  installationIdEnv: string;
}

export type PluginCredentials = OAuthBearerCredentials | GitHubAppCredentials;

export interface PluginManifest {
  name: string;
  description: string;
  capabilities: string[];
  configKeys: string[];
  credentials: PluginCredentials;
  oauth?: {
    clientIdEnv: string;
    clientSecretEnv: string;
    authorizeEndpoint: string;
    tokenEndpoint: string;
    scope: string;
  };
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
