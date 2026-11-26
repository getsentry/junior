import type { ActorIdentity, SpaceReport } from "@sentry/junior/api/schema";
import { lazy, Suspense, useMemo, useState } from "react";

import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import type { ParticipantInvite } from "../../../conversations/ConversationParticipants";
import { DetailsCard } from "../../../conversations/DetailsList";
import {
  useAddSpaceMember,
  useSpaceMembersData,
} from "../../../spaces/queries";

// Settings open only after a click, so their code and their request load
// with the first open instead of with every Space page.
const SpaceSettings = lazy(() =>
  import("../../../spaces/SpaceSettings").then((module) => ({
    default: module.SpaceSettings,
  })),
);

/**
 * A Space's one section in its Lead's details: what the Space is for, and
 * its settings. The Lead's Participants card lists its members.
 */
export function SpaceDetails(props: { space: SpaceReport }) {
  const [open, setOpen] = useState(false);
  return (
    <DetailsCard
      action={
        <Button
          aria-expanded={open}
          className="rounded-md px-1.5 py-0.5 text-xs"
          onClick={() => setOpen((value) => !value)}
          size="bare"
          variant="ghost"
        >
          {open ? "Hide settings" : "Settings"}
        </Button>
      }
      label="Space"
      title="Space"
    >
      {props.space.description ? (
        <p className="m-0 font-sans text-sm leading-relaxed text-dashboard-text-muted">
          {props.space.description}
        </p>
      ) : null}
      {open ? (
        <Suspense fallback={<Skeleton className="h-4 w-1/2" />}>
          <SpaceSettings space={props.space} />
        </Suspense>
      ) : null}
    </DetailsCard>
  );
}

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
