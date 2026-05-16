import {
  createGitHubAdapter,
  type GitHubAdapter,
  type GitHubAdapterConfig,
} from "@chat-adapter/github";
import { normalizeGitHubMentionTarget } from "@/chat/github/mention";

export interface JuniorGitHubAdapterConfig {
  appId: string;
  installationId: number;
  logger?: GitHubAdapterConfig["logger"];
  privateKey: string;
  userName: string;
  webhookSecret: string;
}

/**
 * Create the repository's GitHub adapter.
 *
 * Junior maps repository env names into explicit adapter options so runtime
 * wiring stays stable if adapter-level env defaults change.
 */
export function createJuniorGitHubAdapter(
  config: JuniorGitHubAdapterConfig,
): GitHubAdapter {
  return createGitHubAdapter({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
    webhookSecret: config.webhookSecret,
    userName: normalizeGitHubMentionTarget(config.userName),
    ...(config.logger ? { logger: config.logger } : {}),
  });
}
