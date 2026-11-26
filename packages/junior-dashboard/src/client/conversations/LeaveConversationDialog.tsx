import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

/** Confirm leaving a private conversation, which removes the viewer's access. */
export function LeaveConversationDialog(props: {
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Leave this private conversation?</AlertDialogTitle>
        <AlertDialogDescription>
          You lose access to it. Only someone still in it can invite you back.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Leave</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
