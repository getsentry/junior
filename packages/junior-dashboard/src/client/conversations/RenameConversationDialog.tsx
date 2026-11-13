import { useId, useRef, useState } from "react";
import { CONVERSATION_TITLE_MAX_LENGTH } from "@sentry/junior/api/schema";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field, FieldLabel } from "../components/ui/field";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { useSheet } from "../components/ui/useSheet";

/** Ask for a new conversation title. Saving closes the dialog at once. */
export function RenameConversationDialog(props: {
  title: string;
  onClose(): void;
  onSave(title: string): void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(props.title);
  const sheet = useSheet(props.onClose, inputRef);
  const savedRef = useRef(false);
  const next = title.trim();
  const changed = next.length > 0 && next !== props.title;
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        finalFocus={() => {
          // Base UI returns focus to the opener. After a save from the
          // input, the browser rings that focus. Drop the ring before paint.
          if (savedRef.current) requestAnimationFrame(focusWithoutRing);
          return sheet.contentProps.finalFocus();
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed) props.onSave(next);
            savedRef.current = true;
            sheet.rootProps.onOpenChange(false, { cancel() {} });
          }}
        >
          <DialogTitle>Rename conversation</DialogTitle>
          <Field>
            <FieldLabel htmlFor={inputId}>Title</FieldLabel>
            <Input
              ref={inputRef}
              id={inputId}
              maxLength={CONVERSATION_TITLE_MAX_LENGTH}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="default" type="submit" disabled={!changed}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function focusWithoutRing() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !element.matches(":focus-visible"))
    return;
  element.blur();
  element.focus({ preventScroll: true, focusVisible: false });
}
