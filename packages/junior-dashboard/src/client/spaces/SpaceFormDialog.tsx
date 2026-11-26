import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  SPACE_DESCRIPTION_MAX_CHARS,
  SPACE_NAME_MAX_CHARS,
  type SpaceReport,
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
import { useCreateSpace, useUpdateSpace } from "./queries";
import { spacePath } from "./spaceRoutes";

const CREATE_COPY = {
  failed: "Could not create the Space. Try again.",
  pending: "Creating…",
  submit: "Create Space",
  title: "New Space",
};
const EDIT_COPY = {
  failed: "Could not save the Space. Try again.",
  pending: "Saving…",
  submit: "Save",
  title: "Edit Space",
};

const VISIBILITIES: [SpaceVisibilityReport, string, string][] = [
  ["public", "Public", "Anyone in the organization can find and read it."],
  ["private", "Private", "Only members can find and read it."],
];

/**
 * Create a Space and open it, or edit `space`. Both ask for a name and an
 * optional description. Only a new Space asks who can read it, because a
 * Space keeps the visibility it was created with.
 */
export function SpaceFormDialog(props: {
  onClose(): void;
  space?: SpaceReport | undefined;
}) {
  const { space } = props;
  const nameId = useId();
  const descriptionId = useId();
  const visibilityId = useId();
  const errorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(props.onClose, nameRef);
  const navigate = useNavigate();
  const create = useCreateSpace();
  const update = useUpdateSpace();
  const save = space ? update : create;
  const copy = space ? EDIT_COPY : CREATE_COPY;
  const [name, setName] = useState(space?.name ?? "");
  const [description, setDescription] = useState(space?.description ?? "");
  const [visibility, setVisibility] = useState<SpaceVisibilityReport>("public");
  const changes = {
    description: description.trim() || null,
    name: name.trim(),
  };
  const unchanged =
    space !== undefined &&
    changes.name === space.name &&
    changes.description === space.description;
  const disabled = !changes.name || unchanged || save.isPending;
  const submit = () => {
    if (disabled) return;
    if (space) {
      update.mutate(
        { ...changes, spaceId: space.id },
        { onSuccess: () => sheet.close() },
      );
      return;
    }
    create.mutate(
      { ...changes, visibility },
      {
        onSuccess: (created) => {
          sheet.close();
          void navigate(spacePath(created.id));
        },
      },
    );
  };
  const error = save.error
    ? (save.error instanceof DashboardApiError && save.error.apiError) ||
      copy.failed
    : undefined;
  return (
    <Dialog
      {...sheet.rootProps}
      onOpenChange={(nextOpen, details) => {
        // Keep the dialog until the save answers, so its error can show.
        if (!nextOpen && save.isPending) {
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
          <DialogTitle>{copy.title}</DialogTitle>
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              ref={nameRef}
              id={nameId}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              disabled={save.isPending}
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
              disabled={save.isPending}
              maxLength={SPACE_DESCRIPTION_MAX_CHARS}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
              value={description}
            />
          </Field>
          {space ? null : (
            <FieldSet className="gap-0">
              <FieldLegend id={visibilityId} variant="label">
                Visibility
              </FieldLegend>
              <RadioGroup<SpaceVisibilityReport>
                aria-labelledby={visibilityId}
                className="grid gap-1.5"
                disabled={save.isPending}
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
            </FieldSet>
          )}
          <FieldError id={errorId}>{error}</FieldError>
          <DialogFooter>
            <DialogClose
              disabled={save.isPending}
              render={<Button variant="outline">Cancel</Button>}
            />
            <Button disabled={disabled} type="submit" variant="default">
              {save.isPending ? copy.pending : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
