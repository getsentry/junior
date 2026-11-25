import { lazy, Suspense, useState } from "react";
import { Ellipsis } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useToastManager } from "../components/ui/toast";
import { DashboardApiError } from "../http";
import { inboxViewPath } from "../inbox/inboxModel";
import { useArchiveSpace, useSpaceMembership } from "./queries";
import { spacePath } from "./spaceRoutes";

// The form opens only after a click, so it loads with the first open
// instead of with every page.
const SpaceFormDialog = lazy(() =>
  import("./SpaceFormDialog").then((module) => ({
    default: module.SpaceFormDialog,
  })),
);

/**
 * A member's Space actions: edit, archive or restore the Space, or leave
 * it. The caller renders `rows` inside each menu it has, and `dialogs`
 * once.
 */
export function useSpaceActions(space: SpaceReport) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToastManager();
  const membership = useSpaceMembership(space.id);
  const archive = useArchiveSpace(space.id);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const onSpacePage = pathname === spacePath(space.id);
  // Leaving hides the menu, which drops `mutate` callbacks, so this waits
  // on the promise. A private Space is not readable after the viewer leaves,
  // and the API says why the last member can't leave one.
  const leave = () =>
    membership.mutateAsync(false).then(
      () => {
        if (space.visibility === "private" && onSpacePage)
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
  return {
    rows: (
      <>
        <ContextMenuItem onClick={() => setEditing(true)}>
          Edit Space
        </ContextMenuItem>
        <ContextMenuItem
          disabled={archive.isPending}
          onClick={() =>
            space.archivedAt ? archive.mutate(false) : setConfirmArchive(true)
          }
        >
          {space.archivedAt ? "Restore Space" : "Archive Space"}
        </ContextMenuItem>
        <ContextMenuItem disabled={membership.isPending} onClick={leave}>
          Leave Space
        </ContextMenuItem>
      </>
    ),
    dialogs: (
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
                    archive.mutate(true);
                  }}
                >
                  Archive
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </>
    ),
  };
}

/** A member's Space menu, for the Space's header. */
export function SpaceMenu(props: { className?: string; space: SpaceReport }) {
  const actions = useSpaceActions(props.space);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Space menu"
              className={props.className}
              size="icon"
              variant="ghost"
            >
              <Ellipsis aria-hidden="true" size={18} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {actions.rows}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.dialogs}
    </>
  );
}

/** Join the Space as the viewer. */
export function JoinSpaceButton(props: { space: SpaceReport }) {
  const membership = useSpaceMembership(props.space.id);
  return (
    <Button
      disabled={membership.isPending}
      onClick={() => membership.mutate(true)}
      variant="default"
    >
      Join
    </Button>
  );
}
