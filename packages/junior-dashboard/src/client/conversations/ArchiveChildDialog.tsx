import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

/**
 * Confirm a child archive. It applies to everyone, and the dashboard always
 * archives the child's own children with it. It names no count, because some
 * children can already be archived.
 */
export function ArchiveChildDialog(props: {
  hasChildren: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  const title = props.hasChildren
    ? "Also archive its child conversations?"
    : "Archive for everyone?";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          This hides the conversation
          {props.hasChildren ? " and its child conversations" : ""} for
          everyone. A new message from a person restores it.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
