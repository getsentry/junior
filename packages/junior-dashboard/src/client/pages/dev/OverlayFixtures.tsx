import { Link2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTitle,
  TooltipTrigger,
} from "../../components/ui/tooltip";

/** Exercise anchored controls, tooltips, confirmation focus, and success feedback. */
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
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={<Button aria-label="Copy link" size="icon" />}
          >
            <Link2 aria-hidden="true" size={15} />
          </TooltipTrigger>
          <TooltipContent size="compact">Copy link</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="border-b border-dotted border-dashboard-border-interactive text-sm"
                tabIndex={0}
              />
            }
          >
            $0.42
          </TooltipTrigger>
          <TooltipContent>
            <TooltipTitle>May 1</TooltipTitle>
            12 conversations · 1.2M tokens
          </TooltipContent>
        </Tooltip>
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
                variant="danger"
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
