/**
 * The current model reviewer behind the shared gate, with the authority
 * record. It measures how much of the design the facts and the gate deliver
 * without a new reviewer.
 *
 * The reviewer reads only the proposal, so this shim renders the record into
 * the proposal's root Conversation: each person line becomes a `user`
 * message, before the messages of the Run's own Conversation, and the
 * created resources become one `system` message. A
 * review that cannot run fails only its action (`bounded-failure`). The
 * reviewer itself does not change.
 */
import { createCurrentGuardian } from "@/chat/guardian/current";
import type { AuthorityRecord } from "@/chat/guardian/authority";
import type { Guardian } from "@/chat/guardian/guardian";
import type {
  RootConversationMessage,
  ToolActionProposal,
  ToolActionReviewer,
} from "@/chat/guardian/proposal";

const VIA_NOTES: Record<AuthorityRecord["lines"][number]["via"], string> = {
  instruction: "the request that created this Watch",
  "linked-account": "the person's linked account",
};

const DESTINATION_READERS: Record<
  NonNullable<AuthorityRecord["destinationReaders"]>,
  string
> = {
  anyone: "anyone",
  organization: "people of the organization only",
};

/** Render the authority record as root messages that the reviewer reads. */
function authorityMessages(
  authority: AuthorityRecord,
): RootConversationMessage[] {
  const created = authority.created.map((resource) => resource.ref);
  return [
    ...authority.lines.map((line): RootConversationMessage => ({
      author: "user",
      text: `${line.text}\n(from ${VIA_NOTES[line.via]})`,
    })),
    ...(created.length > 0
      ? [
          {
            author: "system" as const,
            text: `Resources that the same instruction created: ${created.join(", ")}.`,
          },
        ]
      : []),
    ...(authority.destinationReaders
      ? [
          {
            author: "system" as const,
            text: `Who can read the destination of the action: ${DESTINATION_READERS[authority.destinationReaders]}.`,
          },
        ]
      : []),
  ];
}

function withAuthority(
  proposal: ToolActionProposal,
  messages: RootConversationMessage[],
): ToolActionProposal {
  if (messages.length === 0) {
    return proposal;
  }
  return {
    ...proposal,
    rootConversation: {
      messages: [...messages, ...(proposal.rootConversation?.messages ?? [])],
      truncated: proposal.rootConversation?.truncated ?? false,
    },
  };
}

/** Create the legacy Guardian over the current model reviewer. */
export function createLegacyGuardian(reviewer: ToolActionReviewer): Guardian {
  const current = createCurrentGuardian(reviewer);
  return {
    onUnavailable: "fail-action",
    review(request, options) {
      const messages = request.authority
        ? authorityMessages(request.authority)
        : [];
      return current.review(
        {
          actions: request.actions.map((proposal) =>
            withAuthority(proposal, messages),
          ),
        },
        options,
      );
    },
  };
}
