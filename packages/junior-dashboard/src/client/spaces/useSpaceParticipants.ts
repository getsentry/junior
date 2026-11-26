import type { ActorIdentity, SpaceReport } from "@sentry/junior/api/schema";
import { useMemo } from "react";

import type { ParticipantInvite } from "../conversations/ConversationParticipants";
import { useAddSpaceMember, useSpaceMembersData } from "./queries";

/**
 * A Lead's Participants: its Space's members. Invite adds a member, which
 * only a member of a Space that is not archived may do. Until the Space and
 * its members load, the card lists nobody and offers no Invite.
 */
export function useSpaceParticipants(
  spaceId: string | undefined,
  space: SpaceReport | undefined,
):
  | {
      invite: ParticipantInvite;
      participants: readonly ActorIdentity[];
    }
  | undefined {
  const members = useSpaceMembersData(spaceId).data?.members;
  const add = useAddSpaceMember();
  const participants = useMemo(
    () =>
      members?.map((member) => ({
        ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : undefined),
        email: member.email,
        ...(member.displayName ? { fullName: member.displayName } : undefined),
      })) ?? [],
    [members],
  );
  if (!spaceId) return undefined;
  return {
    invite: {
      add: async (user) => {
        await add.mutateAsync({ email: user.email, spaceId });
      },
      allowed: Boolean(space?.viewerIsMember && !space.archivedAt),
      target: { spaceId },
    },
    participants,
  };
}
