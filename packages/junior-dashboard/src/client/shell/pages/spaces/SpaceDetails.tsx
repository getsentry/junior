import type { SpaceReport } from "@sentry/junior/api/schema";
import { lazy, Suspense, useState } from "react";

import { ActorAvatar } from "../../../components/ActorAvatar";
import { DetailsPanel } from "../../../components/DetailsPanel";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
} from "../../../conversations/DetailsList";
import { useSpaceData, useSpaceMembersData } from "../../../spaces/queries";
import { SpaceThreads } from "../../../spaces/SpaceThreads";

// The picker opens only after a click, so it loads with the first open
// instead of with every Space page.
const AddSpaceMembers = lazy(() =>
  import("../../../spaces/AddSpaceMembers").then((module) => ({
    default: module.AddSpaceMembers,
  })),
);

// Settings open only after a click, so their code and their request load
// with the first open instead of with every Space page.
const SpaceSettings = lazy(() =>
  import("../../../spaces/SpaceSettings").then((module) => ({
    default: module.SpaceSettings,
  })),
);

/**
 * The Space beside its Lead: what the Space is for, its Threads, its
 * members, and its settings. On a phone it is a bottom sheet.
 */
export function SpaceDetailsPanel(props: { onClose(): void; spaceId: string }) {
  const space = useSpaceData(props.spaceId).data;
  return (
    <DetailsPanel
      label="Space details"
      onClose={props.onClose}
      title={
        <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
          Space
        </h2>
      }
    >
      <div className="grid min-w-0 content-start gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
        {space ? (
          <SpaceOverview space={space} />
        ) : (
          <Skeleton className="h-4 w-2/3" />
        )}
      </div>
    </DetailsPanel>
  );
}

/** A Space's description, its Threads, its members, and its settings. */
export function SpaceOverview(props: { space: SpaceReport }) {
  const { space } = props;
  return (
    <>
      {space.description ? (
        <p className="m-0 px-1 pb-2 font-sans text-sm leading-relaxed text-dashboard-text-muted">
          {space.description}
        </p>
      ) : null}
      <SpaceThreads spaceId={space.id} />
      <SpaceMembers space={space} />
      <SpaceSettingsCard space={space} />
    </>
  );
}

function SpaceMembers(props: { space: SpaceReport }) {
  const members = useSpaceMembersData(props.space.id);
  const [adding, setAdding] = useState(false);
  return (
    <DetailsCard
      action={
        props.space.viewerIsMember ? (
          <Button
            aria-expanded={adding}
            className="rounded-md px-1.5 py-0.5 text-xs"
            onClick={() => setAdding((value) => !value)}
            size="bare"
            variant="ghost"
          >
            {adding ? "Cancel" : "Add"}
          </Button>
        ) : null
      }
      count={props.space.memberCount}
      label="Members"
      title="Members"
    >
      {adding ? (
        <Suspense fallback={null}>
          <AddSpaceMembers
            onDone={() => setAdding(false)}
            spaceId={props.space.id}
          />
        </Suspense>
      ) : null}
      {members.data ? (
        <DetailsList
          itemKey={(member) => member.userId}
          items={members.data.members}
          renderItem={(member) => {
            const name = member.displayName ?? member.email;
            return (
              <DetailsRow
                icon={
                  <ActorAvatar
                    imageUrl={member.avatarUrl ?? undefined}
                    name={name}
                    size="list"
                  />
                }
                title={name}
              />
            );
          }}
        />
      ) : members.error ? (
        <p className="m-0">Members are unavailable.</p>
      ) : (
        <Skeleton className="h-4 w-28" />
      )}
    </DetailsCard>
  );
}

function SpaceSettingsCard(props: { space: SpaceReport }) {
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
          {open ? "Hide" : "Show"}
        </Button>
      }
      label="Settings"
      title="Settings"
    >
      {open ? (
        <Suspense fallback={<Skeleton className="h-4 w-1/2" />}>
          <SpaceSettings space={props.space} />
        </Suspense>
      ) : null}
    </DetailsCard>
  );
}
