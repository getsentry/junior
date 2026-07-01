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
  StorageMigrationContext,
  StorageMigrationResult,
} from "./operations";
import type {
  BeforeToolExecuteHookContext,
  PluginToolDefinition,
  SandboxPrepareHookContext,
  ToolRegistrationHookContext,
} from "./tools";
import type {
  PromptMessage,
  SystemPromptContext,
  UserPromptContext,
} from "./prompt";

export interface PluginHooks {
  systemPrompt?(
    ctx: SystemPromptContext,
  ): Promise<PromptMessage[]> | PromptMessage[];
  userPrompt?(
    ctx: UserPromptContext,
  ): Promise<PromptMessage[] | undefined> | PromptMessage[] | undefined;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  grantForEgress?(
    ctx: EgressHookContext,
  ): Promise<PluginGrant | undefined> | PluginGrant | undefined;
  heartbeat?(
    ctx: HeartbeatHookContext,
  ): Promise<HeartbeatResult | void> | HeartbeatResult | void;
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
  tools?(
    ctx: ToolRegistrationHookContext,
  ): Record<string, PluginToolDefinition>;
  migrateStorage?(
    ctx: StorageMigrationContext,
  ):
    | Promise<StorageMigrationResult | undefined>
    | StorageMigrationResult
    | undefined;
}
