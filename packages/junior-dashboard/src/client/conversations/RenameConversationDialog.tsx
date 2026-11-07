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
  const next = title.trim();
  const changed = next.length > 0 && next !== props.title;
  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent {...sheet.contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed) props.onSave(next);
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
            <DialogClose render={<Button>Cancel</Button>} />
            <Button variant="primary" type="submit" disabled={!changed}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
