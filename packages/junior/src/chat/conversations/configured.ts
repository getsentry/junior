import { getChatConfig } from "@/chat/config";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
import { createStateConversationStore } from "./state";
import { createSqlStore } from "./sql/store";
import type { ConversationStore } from "./store";

let configuredStore:
  | {
      databaseUrl: string;
      store: ConversationStore;
    }
  | undefined;

/** Return the process-configured conversation record store. */
export function getConfiguredConversationStore(): ConversationStore {
  const databaseUrl = getChatConfig().sql.databaseUrl;
  if (!databaseUrl) {
    return createStateConversationStore();
  }
  if (configuredStore?.databaseUrl !== databaseUrl) {
    configuredStore = {
      databaseUrl,
      store: createSqlStore(
        createNeonJuniorSqlExecutor({ connectionString: databaseUrl }),
      ),
    };
  }
  return configuredStore.store;
}

/** Return whether conversation records use the configured SQL store. */
export function hasConfiguredSqlConversationStore(): boolean {
  return Boolean(getChatConfig().sql.databaseUrl);
}
