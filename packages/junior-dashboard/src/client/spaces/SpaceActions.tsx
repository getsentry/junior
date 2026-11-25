import { useState } from "react";
import { Ellipsis } from "lucide-react";
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
import { useArchiveSpace, useSpaceMembership } from "./queries";

/** A member's Space menu: archive or restore the Space, or leave it. */
export function SpaceMenu(props: { className?: string; space: SpaceReport }) {
  const { space } = props;
  const membership = useSpaceMembership(space.id);
  const archive = useArchiveSpace(space.id);
  const [confirmArchive, setConfirmArchive] = useState(false);
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
          <DropdownMenuItem
            disabled={membership.isPending}
            onClick={() => membership.mutate(false)}
          >
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
