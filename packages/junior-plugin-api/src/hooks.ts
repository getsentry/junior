import type { PluginContext } from "./context";
import type { ObjectAnnotation } from "./object-annotations";
import type {
  ConversationSidebarHookContext,
  ConversationSidebarResult,
} from "./annotations";
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
  ProfileReportHookContext,
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
  PluginEgress,
  PluginToolDefinition,
  SandboxPrepareHookContext,
  ToolRegistrationHookContext,
  WorkspacePrepareHookContext,
  WorkspaceFinalize,
} from "./tools";
import type {
  PromptMessage,
  SystemPromptContext,
  UserPromptContext,
  UserPromptContribution,
} from "./prompt";

/** Input for a pure Markdown rewrite before destination delivery formatting. */
export interface FormatMarkdownHookContext {
  text: string;
}

/** First human message of a new Conversation, given before title generation. */
export interface ConversationTitleContextHookContext extends PluginContext {
  /**
   * String config values of this plugin for the Conversation's Location, by
   * short key. For example, `repo` for the `github.repo` config key.
   */
  config: Record<string, string>;
  /**
   * Host-owned provider egress for title reads. It uses Junior's system
   * identity, so it never uses a user's credentials or starts authorization.
   */
  egress: PluginEgress;
  /** Ends the hook when the host stops waiting for title context. */
  signal: AbortSignal;
  text: string;
}

export interface PluginHooks {
  /**
   * Return short facts that help name a new Conversation, such as
   * `owner/repo#123: Issue title` for a linked issue. Junior shows these facts
   * only to the title model. Return nothing when the message has no known
   * objects.
   */
  conversationTitleContext?(
    ctx: ConversationTitleContextHookContext,
  ): Promise<string[] | undefined> | string[] | undefined;
  conversationSidebar?(
    ctx: ConversationSidebarHookContext,
  ): Promise<ConversationSidebarResult> | ConversationSidebarResult;
  /**
   * Return static guidance for the system prompt. Return the same text for one
   * deployment and platform, so the system prompt stays cacheable. Put text
   * that changes per request in `userPrompt`. See `policies/system-prompt.md`.
   */
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
  afterMcpTool?(
    ctx: AfterMcpToolHookContext,
  ):
    | Promise<{ objectAnnotations: ObjectAnnotation[] } | void>
    | { objectAnnotations: ObjectAnnotation[] }
    | void;
  /**
   * Select the grant for one sandbox egress request.
   *
   * When the manifest also declares generic `credentials` or `apiHeaders`,
   * return undefined to use those credentials for this request.
   */
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
  /**
   * Return one person-scoped operational report for a profile page.
   * Omit or return undefined when the plugin has nothing to show for the subject.
   */
  profileReport?(
    ctx: ProfileReportHookContext,
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
  workspacePrepare?(
    ctx: WorkspacePrepareHookContext,
  ): Promise<WorkspaceFinalize | void> | WorkspaceFinalize | void;
  slackConversationLink?(
    ctx: SlackConversationLinkHookContext,
  ): SlackConversationLink | undefined;
  /** Pure Markdown rewrite. Emit ordinary Markdown only. */
  formatMarkdown?(ctx: FormatMarkdownHookContext): string;
  tools?(
    ctx: ToolRegistrationHookContext,
  ): Record<string, PluginToolDefinition>;
}
