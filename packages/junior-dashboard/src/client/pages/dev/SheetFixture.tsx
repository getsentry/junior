import { Button } from "../../components/Button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";

/** Show the shadcn sheet with the dashboard theme and action controls. */
export function SheetFixture() {
  return (
    <Sheet>
      <SheetTrigger render={<Button />}>Open shadcn sheet</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Sheet details</SheetTitle>
          <SheetDescription>
            Shared surfaces, text, and actions follow the dashboard theme.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 px-4">
          <p className="m-0 text-sm text-muted-foreground">
            Press Escape, use a close control, or click outside to return to the
            page.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Primary action
            </button>
            <button
              type="button"
              className="h-9 rounded-md border border-border px-3 text-sm text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Danger action
            </button>
          </div>
        </div>
        <SheetFooter>
          <SheetClose render={<Button tone="primary" />}>Done</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
