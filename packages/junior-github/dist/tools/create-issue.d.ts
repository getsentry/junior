import { type PluginToolDefinition, type ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
interface CreateGitHubIssueInput {
    body?: unknown;
    labels?: unknown;
    repo?: unknown;
    title?: unknown;
}
/** Own issue creation so provider writes use host egress and the footer stays deterministic. */
export declare function createGitHubIssueTool(ctx: ToolRegistrationHookContext): PluginToolDefinition<CreateGitHubIssueInput>;
export {};
