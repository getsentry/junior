/**
 * The authority record: the facts that core gives Guardian about who may
 * authorize an action, beyond the proposal (`facts-from-junior` in
 * `design/guardian.md`).
 *
 * Code here does only deterministic work. It hashes an action and matches
 * the hash against a recorded confirmation (`confirmed-runs`,
 * `confirm-follows`). Whether a line covers an action is a question of
 * meaning, so it stays with the reviewer.
 */
import { createHash } from "node:crypto";
import type {
  Guardian,
  GuardianActionResult,
  GuardianRequest,
  GuardianResult,
} from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

/**
 * How a line of the person reaches the Run.
 *
 * - `instruction`: the request that this work serves when the Run's own
 *   window does not hold it, such as the request that created a Watch or
 *   an Automation, or one that a long thread pushed out of the window
 *   (`follows-instruction`).
 * - `linked-account`: a message from the person's linked account, also
 *   when an Event delivers it (`linked-account`).
 *
 * A Conversation that an agent started or messaged gets no lines from
 * elsewhere: its own thread, which starts with the brief, is its
 * instruction (`brief-is-instruction`, `no-inheritance`).
 */
export type AuthorityLineVia = "instruction" | "linked-account";

/** One line of the person whose instruction the action serves. */
export interface AuthorityLine {
  text: string;
  via: AuthorityLineVia;
}

/**
 * Facts about who may authorize the actions of one request. Each list holds
 * only what core knows. A Guardian ignores the facts that it does not use.
 */
export interface AuthorityRecord {
  /**
   * The person's lines that reach this Run from elsewhere. The lines of the
   * Run's own Conversation are in each proposal's `rootConversation`.
   */
  lines: AuthorityLine[];
  /** Inbox answers that confirmed one exact action (`confirmed-runs`). */
  confirmations: Array<{ actionHash: string; answerId: string }>;
  /** Resources that the same instruction created, such as a pull request. */
  created: Array<{ ref: string }>;
  /**
   * Grants that a tool's code found for one exact action, from stored facts
   * (`grants`, `grant-facts`). Only a Guardian that applies grants gets
   * them.
   */
  grants: Array<{ actionHash: string; grant: string }>;
  /** Who can read the destination of the actions, when core knows it. */
  destinationReaders?: "organization" | "anyone";
}

/**
 * Copy a JSON value with object keys in sorted order, so two inputs that
 * differ only in key order serialize the same.
 */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

/**
 * Hash one exact action: the tool that the agent called, its input, which
 * names the write target, and the credential subject. A confirmation covers
 * only the action with the same hash (`ask-covers-one`). The reply
 * destination is not part of it, so a child agent's retry of the confirmed
 * action matches (`confirm-follows`).
 */
export function actionHash(action: {
  credentialSubject?: string | undefined;
  input: Record<string, unknown>;
  tool: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalJson({
          credentialSubject: action.credentialSubject ?? null,
          input: action.input,
          tool: action.tool,
        }),
      ),
    )
    .digest("hex");
}

/** Hash the action of one proposal. */
export function proposalActionHash(proposal: ToolActionProposal): string {
  return actionHash({
    credentialSubject: proposal.context.credential?.subject?.userId,
    input: proposal.input,
    tool: proposal.tool.dispatcherName ?? proposal.tool.name,
  });
}

/**
 * Review one request: an action whose hash matches a recorded confirmation
 * runs as the person's decision with no review (`confirmed-runs`). The
 * Guardian reviews the rest, in one request, in order.
 */
export async function reviewWithAuthority(
  guardian: Guardian,
  request: GuardianRequest,
  options: { signal?: AbortSignal | undefined },
): Promise<GuardianResult> {
  const confirmations = request.authority?.confirmations ?? [];
  const confirmedBy = request.actions.map((proposal) => {
    const hash = proposalActionHash(proposal);
    return confirmations.find(
      (confirmation) => confirmation.actionHash === hash,
    )?.answerId;
  });
  const reviewed = request.actions.filter(
    (_, index) => confirmedBy[index] === undefined,
  );
  const result =
    reviewed.length > 0
      ? await guardian.review({ ...request, actions: reviewed }, options)
      : { actions: [], inboxItems: 0 };
  let next = 0;
  const actions = confirmedBy.map((answerId): GuardianActionResult => {
    if (answerId !== undefined) {
      return {
        decidedBy: "person",
        outcome: "allow",
        reason: `The person confirmed this exact action in Inbox answer ${answerId}.`,
      };
    }
    const action = result.actions[next++];
    if (!action) {
      throw new Error("A reviewed action has no Guardian outcome.");
    }
    return action;
  });
  return { actions, inboxItems: result.inboxItems };
}
