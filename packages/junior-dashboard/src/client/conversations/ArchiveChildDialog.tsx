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
 * archives the child's own children with it.
 */
export function ArchiveChildDialog(props: {
  childCount: number;
  onClose(): void;
  onConfirm(): void;
}) {
  const title =
    props.childCount === 0
      ? "Archive for everyone?"
      : `Also archive ${props.childCount} child ${
          props.childCount === 1 ? "conversation" : "conversations"
        }?`;
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
          {props.childCount === 0 ? "" : " and its child conversations"} for
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
