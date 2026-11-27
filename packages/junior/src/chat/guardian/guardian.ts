/**
 * The interface between the tool gate and one Guardian implementation.
 *
 * Core builds one request for each batch of actions that need review: the
 * ordered messages of the work, and each action with what code knows about
 * it (`facts-from-junior` in `design/guardian.md`). An implementation can
 * also read the gate's proposal for each action from `GuardianBatch`.
 */

/** Who can read a target. An unknown audience counts as `world`. */
export type Audience = "internal" | "world";

/** One message of the work, labeled by code from who wrote it. */
export interface Message {
  /**
   * `instruction`: the person the work serves, or the allowed brief.
   * `other_person`: any other person; can restrict, never authorize.
   * `context`: neither, such as agent text and Events.
   */
  from: "instruction" | "other_person" | "context";
  text: string;
}

/** The resource that one action changes, read from stored records. */
export interface Target {
  /** Such as `getsentry/junior#12`. */
  ref: string;
  audience: Audience;
  /** Core sets it from its own records. Upkeep applies only to it. */
  createdByThisWork: boolean;
}

/** One exact action for Guardian. */
export interface Action {
  /** The real tool, never `executeTool`. */
  tool: string;
  /** Evidence for the model only. */
  input: unknown;
  /**
   * `edit` keeps an existing target current, such as its title, body,
   * replies, or CI reruns, but never changes its state. `write` is
   * anything else.
   */
  effect: "edit" | "write";
  target?: Target;
  summary?: string;
}

/** One batch of actions and the messages of the work. */
export interface ReviewRequest {
  /** One call, or every call of one Code Mode batch. */
  actions: Action[];
  /** Oldest first. Every instruction line is kept. */
  messages: Message[];
  /** What the Sandbox can reach, set when the batch has a shell command. */
  sandbox?: {
    repos: { path: string; target: Pick<Target, "ref" | "audience"> }[];
    /** Credential placeholders and the domains each one is sent to. */
    placeholders: { env: string; domains: string[] }[];
  };
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
  /** The rule that matched, also when code cleared it and allowed. */
  rule?: Rule;
  /** An ask names what the person must give. */
  reason: string;
  /** Model cost of this review. */
  costUsd?: number;
}

/** One Guardian implementation. */
export interface Guardian {
  /**
   * One Review per action, in order. Throws when review can't run; the
   * gate then fails only those actions.
   */
  review(request: ReviewRequest, signal: AbortSignal): Promise<Review[]>;
}
