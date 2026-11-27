/**
 * The interface between the tool gate and one Guardian implementation.
 *
 * Core builds one request for each batch of actions that need review: the
 * ordered messages of the work, and each action with what code knows about
 * its call (`facts-from-junior` in `design/guardian.md`). Each Guardian
 * implementation, and the Guardian evals, use only these types.
 */

/** Who can read a target. An unknown audience counts as `world`. */
export type Audience = "internal" | "world";

/** One message of the work, labeled by code from who wrote it. */
export interface Message {
  /**
   * `instruction`: the person the work serves, or the allowed brief.
   * `person`: anyone else; can restrict, never authorize.
   * `context`: neither, such as agent text and Events.
   */
  from: "instruction" | "person" | "context";
  text: string;
}

/** The resource that one call changes, read from stored records. */
export interface Target {
  /** Such as `getsentry/junior#12`. */
  ref: string;
  audience: Audience;
  /** Upkeep applies only to what this work made. */
  createdByThisWork: boolean;
}

/** What one call does, as its tool or core describes it. */
export type Call =
  | {
      /** `sandbox` and `read` skip the model. */
      effect: "sandbox" | "read" | "upkeep" | "write" | "delete";
      /** Set for every effect except `sandbox`, when code knows it. */
      target?: Target;
      summary: string;
    }
  | {
      /** A shell command. The reviewer judges it. */
      effect: "command";
      summary: string;
      repos: { path: string; target: Target }[];
      placeholders: { env: string; domains: string[] }[];
    };

/** One exact action for Guardian. */
export interface Action {
  /** The real tool, never `executeTool`. */
  tool: string;
  call: Call;
  /** Evidence for the model only. */
  input: unknown;
  /** `ask` waits for the person's yes to this exact action. */
  permission: "review" | "ask";
}

/** One batch of actions and the messages of the work. */
export interface ReviewRequest {
  /** One call, or every call of one Code Mode batch. */
  actions: Action[];
  /** Oldest first. Every instruction line is kept. */
  messages: Message[];
  /** Code Mode source. Context only. */
  script?: string;
}

/** A rule that blocks an action. The first three ask, the others deny. */
export type Rule =
  | "restriction"
  | "unrequested"
  | "internal_disclosure"
  | "data_exposure"
  | "credential_probing"
  | "security_weakening"
  | "untrusted_instruction";

/** Guardian's decision for one action. */
export interface Review {
  decision: "allow" | "ask" | "deny";
  rule?: Rule;
  /** An ask names what the person must give. */
  reason: string;
  /** Facts that the decision lacked. */
  missing?: string[];
}

/** One Guardian implementation. */
export interface Guardian {
  /**
   * One Review per action, in order. Throws when review can't run; the
   * gate then fails only those actions.
   */
  review(request: ReviewRequest, signal: AbortSignal): Promise<Review[]>;
}

/** What a tool adds for Guardian. */
export interface ToolDefinition<TInput> {
  permission?: "allow" | "review" | "ask";
  /**
   * From input that already passed `inputSchema`. Reads stored records
   * only. Without it: `readOnlyHint ? "read" : "write"`, no target.
   */
  describeCall?(
    input: TInput,
    ctx: { conversationIds(): Promise<string[]> },
  ): Promise<Call>;
}

/** What a plugin adds for Guardian. */
export interface PluginHooks {
  /** Types a git remote or URL in the Sandbox. */
  describeUrl?(url: URL): Promise<Target | undefined>;
}
