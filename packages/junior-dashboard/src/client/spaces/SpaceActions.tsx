import { useState } from "react";
import { Ellipsis } from "lucide-react";
import { useNavigate } from "react-router";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useToastManager } from "../components/ui/toast";
import { DashboardApiError } from "../http";
import { inboxViewPath } from "../inbox/inboxModel";
import { useArchiveSpace, useSpaceMembership } from "./queries";

/** A member's Space menu: archive or restore the Space, or leave it. */
export function SpaceMenu(props: { className?: string; space: SpaceReport }) {
  const { space } = props;
  const navigate = useNavigate();
  const toast = useToastManager();
  const membership = useSpaceMembership(space.id);
  const archive = useArchiveSpace(space.id);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Leaving hides this menu, which drops `mutate` callbacks, so this waits
  // on the promise. A private Space is not readable after the viewer leaves,
  // and the API says why the last member can't leave one.
  const leave = () =>
    membership.mutateAsync(false).then(
      () => {
        if (space.visibility === "private")
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
          <DropdownMenuItem
            disabled={archive.isPending}
            onClick={() =>
              space.archivedAt ? archive.mutate(false) : setConfirmArchive(true)
            }
          >
            {space.archivedAt ? "Restore Space" : "Archive Space"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={membership.isPending} onClick={leave}>
            Leave Space
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
