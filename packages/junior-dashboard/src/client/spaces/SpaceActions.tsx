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
import {
  useArchiveSpace,
  useSpaceMembership,
  useSpaceVisibility,
} from "./queries";

/**
 * A member's Space menu: make the Space private or public, archive or
 * restore it, or leave it.
 */
export function SpaceMenu(props: { className?: string; space: SpaceReport }) {
  const { space } = props;
  const navigate = useNavigate();
  const toast = useToastManager();
  const membership = useSpaceMembership(space.id);
  const archive = useArchiveSpace(space.id);
  const visibility = useSpaceVisibility(space.id);
  const [confirm, setConfirm] = useState<"archive" | "public">();
  // The API refuses some changes with a message that says why.
  const showError = (title: string) => (error: Error) =>
    toast.add({
      description:
        error instanceof DashboardApiError ? error.apiError : undefined,
      priority: "high",
      title,
      type: "error",
    });
  // Leaving hides this menu, which drops `mutate` callbacks, so this waits
  // on the promise. A private Space is not readable after the viewer leaves.
  const leave = () =>
    membership.mutateAsync(false).then(() => {
      if (space.visibility === "private") void navigate(inboxViewPath("inbox"));
    }, showError("Could not leave the Space"));
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
            disabled={visibility.isPending}
            onClick={() =>
              space.visibility === "private"
                ? setConfirm("public")
                : visibility.mutate("private", {
                    onError: showError("Could not make the Space private"),
                  })
            }
          >
            {space.visibility === "private" ? "Make public" : "Make private"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={archive.isPending}
            onClick={() =>
              space.archivedAt ? archive.mutate(false) : setConfirm("archive")
            }
          >
            {space.archivedAt ? "Restore Space" : "Archive Space"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={membership.isPending} onClick={leave}>
            Leave Space
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirm ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(undefined);
          }}
        >
          <AlertDialogContent>
            {confirm === "archive" ? (
              <>
                <AlertDialogTitle>Archive {space.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This stops and archives every conversation in the Space, for
                  everyone.
                </AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>Make {space.name} public?</AlertDialogTitle>
                <AlertDialogDescription>
                  Everyone in the organization can then read the Space and its
                  conversations.
                </AlertDialogDescription>
              </>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(undefined);
                  if (confirm === "archive") archive.mutate(true);
                  else
                    visibility.mutate("public", {
                      onError: showError("Could not make the Space public"),
                    });
                }}
              >
                {confirm === "archive" ? "Archive" : "Make public"}
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
