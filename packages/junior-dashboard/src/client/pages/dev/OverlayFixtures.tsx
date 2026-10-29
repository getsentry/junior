import { useState } from "react";
import { Button } from "../../components/Button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../components/ui/alert-dialog";
import { useToastManager } from "../../components/ui/toast";

/** Exercise anchored controls, confirmation focus, and success feedback. */
export function OverlayFixtures() {
  const toast = useToastManager();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  return (
    <div className="grid gap-4">
      <div>
        <Popover>
          <PopoverTrigger render={<Button>Open filters</Button>} />
          <PopoverContent>
            <PopoverTitle>Filters</PopoverTitle>
            <p className="m-0 text-sm text-dashboard-text-muted">
              Changes apply immediately.
            </p>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setConfirmationOpen(true)}>
          Delete example
        </Button>
        <Button
          onClick={() => toast.add({ title: "Changes saved", type: "success" })}
        >
          Show success toast
        </Button>
        <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete automation?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete the weekly project summary Automation?
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                tone="danger"
                onClick={() => setConfirmationOpen(false)}
              >
                Delete automation
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
