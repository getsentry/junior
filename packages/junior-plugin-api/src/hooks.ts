import type * as z from "zod";
import type { PluginContext } from "./context";
import type { AnnotatedObject } from "./object-annotations";
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
  SearchUsersHookContext,
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
  GuardianContext,
  GuardianResult,
  AfterToolExecuteHookContext,
  BeforeToolExecuteHookContext,
  PluginEgress,
  PluginToolDefinition,
  SandboxPrepareHookContext,
  ToolRegistrationHookContext,
  WorkspacePrepareHookContext,
  WorkspaceFinalize,
} from "./tools";
import type {
  InboxItemAnsweredHookContext,
  InboxItemDismissedHookContext,
} from "./inbox-items";
import type {
  PromptMessage,
  SystemPromptBuildContext,
  UserPromptContext,
  UserPromptContribution,
} from "./prompt";

/** One call that Guardian reviews, as a plugin's `guardian` hooks see it. */
export interface PluginGuardianCall {
  /** The real tool, such as `bash` or `mcp__linear__save_issue`. */
  tool: string;
  input: Record<string, unknown>;
}

/** What a plugin's `guardian.context` may read. Reads only. */
export interface GuardianFactsContext extends GuardianContext {
  /** The repositories of the active Workspace, such as `owner/name`. */
  workspaceRepos(): Promise<Array<{ provider: string; repo: string }>>;
}

/**
 * What a plugin tells Guardian beyond its own tools' `guardian`. Core turns
 * every answer into one result per call, so one decision path applies.
 */
export interface PluginGuardianHooks {
  /**
   * Facts for Guardian: general ones without a call, and ones about the
   * call with it. Write each line from a template, from plugin code and
   * stored records, never from text that outsiders can write. Lines are
   * facts, never permissions or instructions.
   */
  context?(
    call: PluginGuardianCall | undefined,
    ctx: GuardianFactsContext,
  ): Promise<string[]>;
  /**
   * The `guardian` of a remote MCP tool that has no definition in plugin
   * code, by the exact name that the server lists.
   */
  tools?: Record<
    string,
    (
      input: Record<string, unknown>,
      ctx: GuardianContext,
    ) => Promise<GuardianResult>
  >;
}

/** Input for a pure Markdown rewrite before destination delivery formatting. */

export interface FormatMarkdownHookContext {
  /**
   * String config values of this plugin for the Conversation's Location, by
   * short key, over install defaults. Runtime notices get install defaults.
   */
  config: Record<string, string>;
  /**
   * Return the destination's mention of the one known person who has this
   * provider account, or undefined. Core resolves the `@handle` words in
   * `text` before the hook runs. Insert the result as is. Only Slack text
   * gets mentions: Slack syntax never goes to another place.
   */
  mention(account: { provider: string; handle: string }): string | undefined;
  /**
   * Where the text shows: a Slack message, or the dashboard (`web`). The
   * dashboard shows a bare object link as a card, so keep bare links there.
   */
  platform: "slack" | "web";
  /**
   * The provider that wrote the text or that it went to, such as `github`
   * for a GitHub Event or a comment posted to GitHub. In that text, every
   * `@name` is an account of that provider. Undefined for chat replies.
   */
  provider?: string;
  text: string;
}

/** One Conversation whose history a compaction replaces. */
export type CompactionContextHookContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  conversationId: string;
};

/**
 * Conversations whose transcripts Junior purges. `db` is the purge
 * transaction, so content that the hook deletes goes with the transcript.
 */
export type PurgeConversationsHookContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  conversationIds: string[];
};

/** The child agent that lists its team, and its parent. */
export type ParentAgentFieldContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  /** The child agent's Conversation. */
  conversationId: string;
  parentConversationId: string;
};

/**
 * A field that this plugin adds to the parent's entry when a child agent
 * lists its team. The field has the plugin's name.
 */
export interface ParentAgentField {
  /** What the field shows, such as "the parent's open tasks". */
  description: string;
  /** Output schema of the field. Describe it for the model. */
  schema: z.ZodType;
  /** Read the field value, or undefined to leave the field out. */
  load(ctx: ParentAgentFieldContext): Promise<unknown>;
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
   * Return static guidance for the system prompts of one platform. Junior
   * runs this hook once at build for each platform, uses its output in the
   * system prompt of every Prompt mode on that platform, and freezes it for
   * the deployment. So every Turn gets the same system prompt, and the model
   * provider can cache it. The hook may do I/O, but that I/O happens only at
   * build. Put text that changes per request in `userPrompt`.
   */
  systemPrompt?(
    ctx: SystemPromptBuildContext,
  ): Promise<PromptMessage[]> | PromptMessage[];
  /**
   * Return per-request context for a new prompt, such as recalled memories.
   * Junior runs this hook at the same time as Turn routing and sandbox setup,
   * so it must not depend on either.
   */
  userPrompt?(
    ctx: UserPromptContext,
  ):
    | Promise<UserPromptContribution[] | undefined>
    | UserPromptContribution[]
    | undefined;
  beforeToolExecute?(ctx: BeforeToolExecuteHookContext): Promise<void> | void;
  /**
   * Check a tool call after it runs, such as a judge for the files that it
   * changed. Use `ctx.decision` to add guidance or reject the result.
   */
  afterToolExecute?(ctx: AfterToolExecuteHookContext): Promise<void> | void;
  /**
   * Run after a successful hosted MCP tool call.
   *
   * Prefer this for junior-owned side effects such as conversation annotations.
   * Do not use it to invent a parallel tool contract for the provider tool.
   */
  afterMcpTool?(
    ctx: AfterMcpToolHookContext,
  ):
    | Promise<{ objectAnnotations: AnnotatedObject[] } | void>
    | { objectAnnotations: AnnotatedObject[] }
    | void;
  /**
   * Guardian facts and remote MCP tool decisions. A remote tool without an
   * entry in `tools` gets the manifest's `mcp.guardian.audience`, else
   * `world`.
   */
  guardian?: PluginGuardianHooks;
  /**
   * Select the grant for one sandbox egress request.
   *
   * When the manifest also declares generic `credentials` or `apiHeaders`,
   * return undefined to use those credentials for this request.
   */
  grantForEgress?(
    ctx: EgressHookContext,
  ): Promise<PluginGrant | undefined> | PluginGrant | undefined;
  /**
   * Do the work that a person asked for with a choice on an item that this
   * plugin added. Junior calls it again when the person retries after a
   * failure, so it must be safe to repeat.
   */
  inboxItemAnswered?(ctx: InboxItemAnsweredHookContext): Promise<void> | void;
  /**
   * Remove the person who dismissed an item of an `assigneeRoles` subject
   * kind from the object on the provider. Throw when the provider refuses:
   * the dismiss then fails, and the person stays on the item. Junior calls
   * it again when the person retries, so it must be safe to repeat.
   */
  inboxItemDismissed?(ctx: InboxItemDismissedHookContext): Promise<void> | void;
  /**
   * Return state that the model must keep when a compaction replaces the
   * history, such as open work. Junior adds it to the compaction summary.
   */
  compactionContext?(
    ctx: CompactionContextHookContext,
  ): Promise<PromptMessage[] | undefined> | PromptMessage[] | undefined;
  /**
   * Delete this plugin's content of Conversations whose transcripts Junior
   * purges, such as text that came from the transcript.
   */
  purgeConversations?(ctx: PurgeConversationsHookContext): Promise<void>;
  /** Return the field that this plugin adds to a child agent's parent entry. */
  parentAgentField?(): ParentAgentField;
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
  /**
   * Return the provider accounts that match a person search. Return only
   * close matches, such as an exact login, so the agent can choose between
   * them. `userLookup` links each account to a known person.
   */
  searchUsers?(
    ctx: SearchUsersHookContext,
  ): Promise<PluginProviderAccount[]> | PluginProviderAccount[];
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
  /**
   * Tools by plugin-local camelCase name. Read only deployment configuration
   * here, never Turn context: the host reads them with no Turn, and passes
   * the Turn context to each `execute` call.
   */
  tools?(): Record<string, PluginToolDefinition>;
  /**
   * Tools from `tools()` that this Turn cannot run, with the reason. The host
   * keeps them in the tool list, so the cached prompt stays the same, and
   * rejects their calls.
   */
  disabledTools?(ctx: ToolRegistrationHookContext): Record<string, string>;
}
