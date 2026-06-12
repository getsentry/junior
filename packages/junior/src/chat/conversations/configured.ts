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

/** Return whether process configuration points Junior at SQL. */
export function hasConfiguredJuniorDatabase(): boolean {
  return Boolean(getChatConfig().sql.databaseUrl);
}

/** Return the process-configured conversation feed store. */
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
