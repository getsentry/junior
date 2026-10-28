/**
 * The default `createApp()` options of the skills suite. Each test in the
 * suite runs on an agent with these options. `skills.ts` also adds the
 * fixture skills with `SKILL_DIRS`.
 */
import { defineJuniorPlugins, type JuniorAppOptions } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

/** Lookup tools of the eval MCP server. */
const evalMcpPlugin = defineJuniorPlugin({
  manifest: {
    name: "eval-mcp",
    displayName: "Eval MCP",
    description: "Eval-only MCP lookup fixture",
    mcp: {
      transport: "http",
      url: "https://eval-mcp.example.test/mcp",
      allowedTools: ["handbook-search", "find-person"],
    },
  },
});

/** Tools of the eval MCP server that delete data and export a credential. */
const evalGuardianActionsPlugin = defineJuniorPlugin({
  manifest: {
    name: "eval-guardian-actions",
    displayName: "Eval Guardian Actions",
    description: "Exercises approval review for consequential eval actions",
    mcp: {
      transport: "http",
      url: "https://eval-mcp.example.test/mcp",
      allowedTools: ["delete-eval-workspace", "export-eval-credentials"],
    },
  },
});

export default {
  plugins: defineJuniorPlugins([evalMcpPlugin, evalGuardianActionsPlugin]),
} satisfies JuniorAppOptions;
