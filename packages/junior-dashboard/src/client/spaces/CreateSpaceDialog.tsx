import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  SPACE_DESCRIPTION_MAX_CHARS,
  SPACE_NAME_MAX_CHARS,
  type SpaceVisibilityReport,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import { useSheet } from "../components/ui/useSheet";
import { DashboardApiError } from "../http";
import { useCreateSpace } from "./queries";
import { spacePath } from "./spaceRoutes";

const VISIBILITIES: [SpaceVisibilityReport, string, string][] = [
  ["public", "Public", "Anyone in the organization can find and read it."],
  ["private", "Private", "Only members can find and read it."],
];

/**
 * Ask for a name, an optional description, and who can read the Space, then
 * open the new Space.
 */
export function CreateSpaceDialog(props: { onClose(): void }) {
  const nameId = useId();
  const descriptionId = useId();
  const visibilityId = useId();
  const errorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, nameRef);
  const navigate = useNavigate();
  const create = useCreateSpace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<SpaceVisibilityReport>("public");
  const submit = () => {
    if (!name.trim() || create.isPending) return;
    create.mutate(
      {
        description: description.trim() || null,
        name: name.trim(),
        visibility,
      },
      {
        onSuccess: (space) => {
          sheet.close();
          void navigate(spacePath(space.id));
        },
      },
    );
  };
  const error = create.error
    ? (create.error instanceof DashboardApiError && create.error.apiError) ||
      "Could not create the Space. Try again."
    : undefined;
  return (
    <Dialog
      {...sheet.rootProps}
      onOpenChange={(nextOpen, details) => {
        // Keep the dialog until the create answers, so its error can show.
        if (!nextOpen && create.isPending) {
          details.cancel();
          return;
        }
        sheet.rootProps.onOpenChange(nextOpen, details);
      }}
    >
      <DialogContent {...sheet.contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogTitle>New Space</DialogTitle>
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              ref={nameRef}
              id={nameId}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              disabled={create.isPending}
              maxLength={SPACE_NAME_MAX_CHARS}
              onChange={(event) => setName(event.target.value)}
              placeholder="Billing migration"
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
            <Textarea
              id={descriptionId}
              className="min-h-20 leading-relaxed"
              disabled={create.isPending}
              maxLength={SPACE_DESCRIPTION_MAX_CHARS}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
              value={description}
            />
          </Field>
          <FieldSet className="gap-0">
            <FieldLegend id={visibilityId} variant="label">
              Visibility
            </FieldLegend>
            <RadioGroup<SpaceVisibilityReport>
              aria-labelledby={visibilityId}
              className="grid gap-1.5"
              disabled={create.isPending}
              onValueChange={setVisibility}
              value={visibility}
            >
              {VISIBILITIES.map(([value, label, help]) => (
                <FieldLabel key={value}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={value} />
                    <FieldContent>
                      <FieldTitle>{label}</FieldTitle>
                      <FieldDescription>{help}</FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
            <FieldError id={errorId}>{error}</FieldError>
          </FieldSet>
          <DialogFooter>
            <DialogClose
              disabled={create.isPending}
              render={<Button variant="outline">Cancel</Button>}
            />
            <Button
              disabled={!name.trim() || create.isPending}
              type="submit"
              variant="default"
            >
              {create.isPending ? "Creating…" : "Create Space"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
