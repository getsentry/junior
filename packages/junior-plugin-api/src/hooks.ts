import type {
  EgressHookContext,
  EgressResponseHookContext,
  IssueCredentialHookContext,
  PluginCredentialResult,
  PluginGrant,
  PluginProviderAccount,
  ResolveOAuthAccountHookContext,
} from "./credentials";
import type {
  HeartbeatHookContext,
  HeartbeatResult,
  OperationalReportHookContext,
  ApiRouteRegistrationHookContext,
  PluginOperationalReportContent,
  PluginRoute,
  PluginRouteApp,
  RouteRegistrationHookContext,
  SlackConversationLink,
  SlackConversationLinkHookContext,
  UnfinishedWorkHookContext,
  UnfinishedWorkResult,
} from "./operations";
import type {
  AfterMcpToolHookContext,
  BeforeToolExecuteHookContext,
  PluginToolDefinition,
  SandboxPrepareHookContext,
  ToolRegistrationHookContext,
} from "./tools";
import type {
  PromptMessage,
  SystemPromptContext,
  UserPromptContext,
  UserPromptContribution,
} from "./prompt";
import type { PluginContext } from "./context";

/** One plugin-owned markdown rewrite before destination delivery formatting. */
export interface FormatMarkdownHookContext
  extends Pick<PluginContext, "db" | "log" | "plugin"> {
  text: string;
}

export interface PluginHooks {
  systemPrompt?(
    ctx: SystemPromptContext,
  ): Promise<PromptMessage[]> | PromptMessage[];
  userPrompt?(
    ctx: UserPromptContext,
  ):
    | Promise<UserPromptContribution[] | undefined>
    | UserPromptContribution[]
    | undefined;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  /**
   * Run after a successful hosted MCP tool call.
   *
   * Prefer this for junior-owned side effects such as conversation annotations.
   * Do not use it to invent a parallel tool contract for the provider tool.
   */
  afterMcpTool?(ctx: AfterMcpToolHookContext): Promise<void> | void;
  grantForEgress?(
    ctx: EgressHookContext,
  ): Promise<PluginGrant | undefined> | PluginGrant | undefined;
  heartbeat?(
    ctx: HeartbeatHookContext,
  ): Promise<HeartbeatResult | void> | HeartbeatResult | void;
  unfinishedWork?(
    ctx: UnfinishedWorkHookContext,
  ): Promise<UnfinishedWorkResult> | UnfinishedWorkResult;
  issueCredential?(
    ctx: IssueCredentialHookContext,
  ): Promise<PluginCredentialResult> | PluginCredentialResult;
  onEgressResponse?(ctx: EgressResponseHookContext): Promise<void> | void;
  operationalReport?(
    ctx: OperationalReportHookContext,
  ):
    | Promise<PluginOperationalReportContent | undefined>
    | PluginOperationalReportContent
    | undefined;
  /** Return plugin-owned product API routes mounted under Junior's authenticated plugin namespace. */
  apiRoutes?(ctx: ApiRouteRegistrationHookContext): PluginRouteApp | undefined;
  resolveOAuthAccount?(
    ctx: ResolveOAuthAccountHookContext,
  ):
    | Promise<PluginProviderAccount | undefined>
    | PluginProviderAccount
    | undefined;
  routes?(ctx: RouteRegistrationHookContext): PluginRoute[];
  sandboxPrepare?(ctx: SandboxPrepareHookContext): Promise<void> | void;
  slackConversationLink?(
    ctx: SlackConversationLinkHookContext,
  ): SlackConversationLink | undefined;
  /**
   * Rewrite provider-owned references into ordinary Markdown before destination
   * delivery formatting. Keep this destination-neutral; do not emit Slack mrkdwn.
   */
  formatMarkdown?(ctx: FormatMarkdownHookContext): string;
  tools?(
    ctx: ToolRegistrationHookContext,
  ): Record<string, PluginToolDefinition>;
}
