import {
  pluginProviderAccountSchema,
  type PluginEgress,
  type PluginProviderAccount,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";

const searchResultSchema = z.array(pluginProviderAccountSchema);

/** Accounts that one provider's search returned. */
export interface ProviderAccounts {
  provider: string;
  accounts: PluginProviderAccount[];
}

/** Return providers whose plugin can search its accounts for a person. */
export function getUserSearchProviders(): string[] {
  return getPlugins()
    .filter((plugin) => Boolean(plugin.hooks?.searchUsers))
    .map((plugin) => plugin.manifest.name);
}

/** Ask each listed provider's plugin for the accounts that match a query. */
export async function searchPluginUsers(input: {
  egress: PluginEgress;
  providers: string[];
  query: string;
}): Promise<ProviderAccounts[]> {
  const searches = getPlugins().flatMap((plugin) => {
    const search = plugin.hooks?.searchUsers;
    return search && input.providers.includes(plugin.manifest.name)
      ? [{ plugin, search }]
      : [];
  });
  return await mapBounded(searches, async ({ plugin, search }) => {
    const result = searchResultSchema.safeParse(
      await search({
        ...basePluginContext(plugin),
        egress: input.egress,
        query: input.query,
      }),
    );
    if (!result.success) {
      throw new Error(
        `Plugin "${plugin.manifest.name}" searchUsers returned invalid accounts`,
      );
    }
    return { provider: plugin.manifest.name, accounts: result.data };
  });
}
