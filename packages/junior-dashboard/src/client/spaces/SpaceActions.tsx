import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { SpaceReport } from "@sentry/junior/api/schema";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { ContextMenuItem } from "../components/ui/context-menu";
import { useToastManager } from "../components/ui/toast";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import { DashboardApiError } from "../http";
import { inboxViewPath } from "../inbox/inboxModel";
import { conversationIdFromPath } from "../shell/inboxMobileHeader";
import { useArchiveSpace, useSpaceMembership, useUpdateSpace } from "./queries";
import { spacePath } from "./spaceRoutes";

// The form opens only after a click, so it loads with the first open
// instead of with every page.
const SpaceFormDialog = lazy(() =>
  import("./SpaceFormDialog").then((module) => ({
    default: module.SpaceFormDialog,
  })),
);

/**
 * A member's Space actions: edit, rename, archive or restore the Space, or
 * join or leave it. The pane renders `rows` in a Space's menu, and a Lead's
 * Conversation menu calls the actions. The caller renders `dialogs` once.
 * Without a Space, the actions do nothing.
 */
export function useSpaceActions(space: SpaceReport | undefined) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToastManager();
  const membership = useSpaceMembership();
  const archive = useArchiveSpace();
  const update = useUpdateSpace();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const queryClient = useQueryClient();
  // Whether the open page shows the Space or a Conversation in it. Read it
  // before a leave, which drops the cached details of a private Space.
  const pageInSpace = (spaceId: string) => {
    if (pathname === spacePath(spaceId)) return true;
    const conversationId = conversationIdFromPath(pathname);
    return (
      conversationId !== undefined &&
      queryClient.getQueryData<ConversationSnapshot>(
        conversationDetailQueryKey(conversationId),
      )?.space?.id === spaceId
    );
  };
  // Leaving hides the menu, which drops `mutate` callbacks, so this waits
  // on the promise. A private Space is not readable after the viewer leaves,
  // and the API says why the last member can't leave one.
  const leave = () => {
    if (!space) return;
    const leavesPage = space.visibility === "private" && pageInSpace(space.id);
    void membership.mutateAsync({ join: false, spaceId: space.id }).then(
      () => {
        if (leavesPage)
          void navigate(inboxViewPath("inbox"), { replace: true });
      },
      (error: Error) =>
        toast.add({
          description:
            error instanceof DashboardApiError ? error.apiError : undefined,
          priority: "high",
          title: "Could not leave the Space",
          type: "error",
        }),
    );
  };
  const toggleArchive = () => {
    if (!space) return;
    if (space.archivedAt)
      archive.mutate({ archived: false, spaceId: space.id });
    else setConfirmArchive(true);
  };
  return {
    archive: toggleArchive,
    join: () => {
      if (space) membership.mutate({ join: true, spaceId: space.id });
    },
    leave,
    pending: { archive: archive.isPending, membership: membership.isPending },
    /** A Space and its Lead share one name. */
    rename: (name: string) => {
      if (!space) return;
      update.mutate({
        description: space.description,
        name,
        spaceId: space.id,
      });
    },
    rows: space ? (
      <>
        <ContextMenuItem onClick={() => setEditing(true)}>
          Edit Space
        </ContextMenuItem>
        <ContextMenuItem disabled={archive.isPending} onClick={toggleArchive}>
          {space.archivedAt ? "Restore Space" : "Archive Space"}
        </ContextMenuItem>
        <ContextMenuItem disabled={membership.isPending} onClick={leave}>
          Leave Space
        </ContextMenuItem>
      </>
    ) : null,
    dialogs: space ? (
      <>
        {editing ? (
          <Suspense fallback={null}>
            <SpaceFormDialog onClose={() => setEditing(false)} space={space} />
          </Suspense>
        ) : null}
        {confirmArchive ? (
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open) setConfirmArchive(false);
            }}
          >
            <AlertDialogContent>
              <AlertDialogTitle>Archive {space.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This stops and archives every conversation in the Space, for
                everyone.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmArchive(false);
                    archive.mutate({ archived: true, spaceId: space.id });
                  }}
                >
                  Archive
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </>
    ) : null,
  };
}

/** Join the Space as the viewer. */
export function JoinSpaceButton(props: { space: SpaceReport }) {
  const membership = useSpaceMembership();
  return (
    <Button
      disabled={membership.isPending}
      onClick={() => membership.mutate({ join: true, spaceId: props.space.id })}
      variant="default"
    >
      Join
    </Button>
  );
}
