import { getChatConfig, type SqlDriver } from "@/chat/config";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
import { createStateConversationStore } from "./state";
import { createSqlStore } from "./sql/store";
import type { ConversationStore } from "./store";

let configuredStore:
  | {
      databaseUrl: string;
      driver: SqlDriver;
      executor: ReturnType<typeof createJuniorSqlExecutor>;
      store: ConversationStore;
    }
  | undefined;

/** Return the process-configured conversation record store. */
export function getConfiguredConversationStore(): ConversationStore {
  const databaseUrl = getChatConfig().sql.databaseUrl;
  const driver = getChatConfig().sql.driver;
  if (!databaseUrl) {
    return createStateConversationStore();
  }
  if (
    configuredStore?.databaseUrl !== databaseUrl ||
    configuredStore.driver !== driver
  ) {
    void configuredStore?.executor.close().catch(() => undefined);
    const executor = createJuniorSqlExecutor({
      connectionString: databaseUrl,
      driver,
    });
    configuredStore = {
      databaseUrl,
      driver,
      executor,
      store: createSqlStore(executor),
    };
  }
  return configuredStore.store;
}

/** Return whether conversation records use the configured SQL store. */
export function hasConfiguredSqlConversationStore(): boolean {
  return Boolean(getChatConfig().sql.databaseUrl);
}

/** Close the configured SQL conversation store if one has been created. */
export async function closeConfiguredConversationStore(): Promise<void> {
  const current = configuredStore;
  configuredStore = undefined;
  await current?.executor.close();
}
