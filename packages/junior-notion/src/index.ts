/**
 * Notion plugin runtime boundary.
 *
 * Junior reads and writes Notion through Notion's hosted MCP server with
 * each person's own MCP login, or the optional service account. Link cards
 * read a page with only the viewer's own login, so Notion decides who sees
 * each card.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { notionCovers } from "./links/covers.js";
import { notionPageLinks } from "./links/pages.js";

/** Register Junior's Notion plugin. */
export function notionPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-notion",
    images: notionCovers,
    objectLinks: [notionPageLinks],
    manifest: {
      name: "notion",
      displayName: "Notion",
      description: "Notion page search, fetch, and limited write workflows",
      mcp: {
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        allowedTools: [
          "notion-search",
          "notion-fetch",
          "notion-create-pages",
          "notion-update-page",
          "notion-move-pages",
        ],
      },
      // Optional shared account. It has no effect until an admin connects
      // it on the dashboard Admin page. It can create and update pages so
      // scheduled automations can write without a person's Notion login.
      // Moves stay per-user because they change who can see the moved
      // pages.
      accounts: {
        serviceAccount: {
          tools: [
            "notion-search",
            "notion-fetch",
            "notion-create-pages",
            "notion-update-page",
          ],
        },
      },
    },
  });
}
