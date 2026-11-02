import { ArrowRight } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  buttonUserInputField,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputField,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";

// Each choice is a whole selectable row, so the hit area and the selected
// state read at a glance. The control inside keeps its own focus ring.
const optionClass =
  "flex cursor-pointer items-start gap-3 rounded-md border border-dashboard-border bg-dashboard-surface-panel px-3 py-2.5 text-sm transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover has-[[data-checked]]:border-dashboard-accent/60 has-[[data-checked]]:bg-dashboard-accent/10 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60";

// A described choice is one button row, so its description stays beside its
// label and one click is still the answer. The picked row keeps the accent
// while the answer sends.
const choiceButtonClass =
  "group flex w-full cursor-pointer items-center gap-3 rounded-md border border-dashboard-border bg-dashboard-surface-raised px-3 py-2.5 text-left font-sans text-sm transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed disabled:opacity-60 data-[picked]:border-dashboard-accent/60 data-[picked]:bg-dashboard-accent/10 data-[picked]:opacity-100";

function OptionText(props: { description?: string; label: string }) {
  return (
    <span className="grid min-w-0 gap-0.5 break-words">
      <span className="font-medium text-dashboard-text">{props.label}</span>
      {props.description ? (
        <span className="text-xs text-dashboard-text-muted">
          {props.description}
        </span>
      ) : null}
    </span>
  );
}

function ChoiceField(props: {
  disabled: boolean;
  field: Extract<UserInputField, { kind: "choice" | "multi_choice" }>;
  onChange(values: string[]): void;
  values: string[];
}) {
  const id = useId();
  const { field } = props;
  const legend = (
    <legend className="mb-2 p-0 text-sm font-semibold text-dashboard-text">
      {field.label}
    </legend>
  );
  const description = field.description ? (
    <FieldDescription className="-mt-1 mb-2" id={`${id}-help`}>
      {field.description}
    </FieldDescription>
  ) : null;
  const describedBy = field.description ? `${id}-help` : undefined;
  if (field.kind === "choice") {
    return (
      <fieldset className="m-0 min-w-0 border-0 p-0">
        {legend}
        {description}
        <RadioGroup
          aria-describedby={describedBy}
          aria-label={field.label}
          className="grid gap-2"
          disabled={props.disabled}
          onValueChange={(value) => props.onChange([String(value)])}
          value={props.values[0] ?? null}
        >
          {field.options.map((option) => (
            <label className={optionClass} key={option.label}>
              <RadioGroupItem className="mt-0.5" value={option.label} />
              <OptionText
                description={option.description}
                label={option.label}
              />
            </label>
          ))}
        </RadioGroup>
      </fieldset>
    );
  }
  return (
    <fieldset
      aria-describedby={describedBy}
      className="m-0 min-w-0 border-0 p-0"
    >
      {legend}
      {description}
      <div className="grid gap-2">
        {field.options.map((option) => (
          <label className={optionClass} key={option.label}>
            <Checkbox
              checked={props.values.includes(option.label)}
              className="mt-0.5"
              disabled={props.disabled}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? [...props.values, option.label]
                    : props.values.filter((value) => value !== option.label),
                )
              }
            />
            <OptionText description={option.description} label={option.label} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TextField(props: {
  className?: string;
  description?: string;
  disabled: boolean;
  label: string;
  onChange(value: string): void;
  value: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      {props.description ? (
        <FieldDescription className="-mt-1" id={`${id}-help`}>
          {props.description}
        </FieldDescription>
      ) : null}
      <Textarea
        aria-describedby={props.description ? `${id}-help` : undefined}
        className={cn("min-h-20 leading-relaxed", props.className)}
        disabled={props.disabled}
        id={id}
        onChange={(event) => props.onChange(event.target.value)}
        value={props.value}
      />
    </Field>
  );
}

/**
 * Render the answer controls of an action item request. A request with
 * one short choice field shows one button per choice, and a click is the
 * answer. Choices with descriptions stack as rows, so each description stays
 * with its choice. Other requests show a form that the reader submits once.
 * A failed `onSubmit` lets the reader try again. `secondaryActions`, such as
 * Dismiss, sit after the answer controls.
 */
export function UserInputForm(props: {
  onSubmit(answer: UserInputAnswer): Promise<void>;
  request: UserInputRequest;
  requestId: string;
  secondaryActions?: ReactNode;
}) {
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [failed, setFailed] = useState(false);
  const choicesId = useId();
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");
  const buttonField = buttonUserInputField(props.request);

  // A ref blocks a second click before React renders the disabled controls.
  // The lock stays after a sent answer; only a failed send can retry.
  const sendLock = useRef(false);

  async function send(answer: UserInputAnswer) {
    if (sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setFailed(false);
    try {
      await props.onSubmit(answer);
    } catch {
      sendLock.current = false;
      setSending(false);
      setPicked(undefined);
      setFailed(true);
    }
  }

  /** Send one button choice as the whole answer. */
  function pick(fieldId: string, label: string) {
    setPicked(label);
    void send({ requestId: props.requestId, values: { [fieldId]: [label] } });
  }

  const answer: UserInputAnswer = {
    other,
    requestId: props.requestId,
    values,
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !isEmptyUserInputAnswer(normalizeUserInputAnswer(props.request, answer))
    ) {
      void send(answer);
    }
  }

  const secondary = props.secondaryActions ? (
    <div className="flex flex-wrap gap-1 sm:ml-auto">
      {props.secondaryActions}
    </div>
  ) : null;

  return (
    <>
      {buttonField?.options.some((option) => option.description) ? (
        <>
          <div
            aria-label={buttonField.label}
            className="mt-3 grid gap-2"
            role="group"
          >
            {buttonField.options.map((option, index) => (
              <button
                aria-describedby={
                  option.description ? `${choicesId}-${index}` : undefined
                }
                aria-labelledby={`${choicesId}-${index}-label`}
                className={choiceButtonClass}
                data-picked={picked === option.label ? "" : undefined}
                disabled={sending}
                key={option.label}
                onClick={() => pick(buttonField.id, option.label)}
                type="button"
              >
                <span className="grid min-w-0 flex-1 gap-0.5 break-words">
                  <span
                    className="font-medium text-dashboard-text"
                    id={`${choicesId}-${index}-label`}
                  >
                    {option.label}
                  </span>
                  {option.description ? (
                    <span
                      className="text-xs text-dashboard-text-muted"
                      id={`${choicesId}-${index}`}
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="shrink-0 text-dashboard-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[picked]:opacity-100"
                  size={16}
                />
              </button>
            ))}
          </div>
          {secondary ? (
            <div className="mt-3 flex flex-wrap items-center">{secondary}</div>
          ) : null}
        </>
      ) : buttonField ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {buttonField.options.map((option) => (
            <Button
              disabled={sending}
              key={option.label}
              onClick={() => pick(buttonField.id, option.label)}
            >
              {option.label}
            </Button>
          ))}
          {secondary}
        </div>
      ) : (
        <form className="mt-4 grid gap-5" onSubmit={submit}>
          {props.request.fields.map((field) =>
            field.kind === "text" ? (
              <TextField
                description={field.description}
                disabled={sending}
                key={field.id}
                label={field.label}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.id]: [value] }))
                }
                value={values[field.id]?.[0] ?? ""}
              />
            ) : (
              <ChoiceField
                disabled={sending}
                field={field}
                key={field.id}
                onChange={(picked) =>
                  setValues((current) => ({ ...current, [field.id]: picked }))
                }
                values={values[field.id] ?? []}
              />
            ),
          )}
          <TextField
            className="min-h-16"
            description="Optional. Anything else, or an answer that is not listed."
            disabled={sending}
            label="Other"
            onChange={setOther}
            value={other}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={sending} type="submit" variant="primary">
              Send
            </Button>
            {secondary}
          </div>
        </form>
      )}
      {failed ? (
        <p className="mb-0 mt-2 text-xs text-rose-300" role="alert">
          Could not send your answer. Try again.
        </p>
      ) : null}
    </>
  );
}
