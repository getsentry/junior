/**
 * Process-configured conversation metadata store boundary.
 *
 * Production uses SQL when a database URL is configured; local/default runs use
 * the state-backed adapter. Cache SQL stores by URL so Neon pools are reused
 * without freezing test configuration changes.
 */
import { getChatConfig } from "@/chat/config";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
import { createStateConversationMetadataStore } from "./state-store";
import { createSqlConversationMetadataStore } from "./sql/store";
import type { ConversationMetadataStore } from "./store";

let configuredStore:
  | {
      databaseUrl: string;
      store: ConversationMetadataStore;
    }
  | undefined;

/** Return whether process configuration points conversation metadata at SQL. */
export function hasConfiguredConversationMetadataDatabase(): boolean {
  return Boolean(getChatConfig().sql.databaseUrl);
}

/** Return the process-configured conversation metadata store. */
export function getConfiguredConversationMetadataStore(): ConversationMetadataStore {
  const databaseUrl = getChatConfig().sql.databaseUrl;
  if (!databaseUrl) {
    return createStateConversationMetadataStore();
  }
  if (configuredStore?.databaseUrl !== databaseUrl) {
    configuredStore = {
      databaseUrl,
      store: createSqlConversationMetadataStore(
        createNeonJuniorSqlExecutor({ connectionString: databaseUrl }),
      ),
    };
  }
  return configuredStore.store;
}
