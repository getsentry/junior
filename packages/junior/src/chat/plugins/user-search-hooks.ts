import {
  pluginProviderAccountSchema,
  type PluginEgress,
  type PluginProviderAccount,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import { getPlugins } from "@/chat/plugins/hooks/registry";
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

/**
 * Ask each listed provider's plugin for the accounts that match a query. A
 * search that fails or returns invalid accounts is logged and left out.
 */
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
    const context = basePluginContext(plugin);
    const provider = plugin.manifest.name;
    try {
      const result = searchResultSchema.safeParse(
        await search({ ...context, egress: input.egress, query: input.query }),
      );
      if (result.success) return { provider, accounts: result.data };
      context.log.warn("plugin.search_users.invalid_result", { provider });
    } catch (error) {
      // One provider's search must not fail the whole lookup.
      context.log.warn("plugin.search_users.failed", {
        provider,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
    return { provider, accounts: [] };
  });
}
