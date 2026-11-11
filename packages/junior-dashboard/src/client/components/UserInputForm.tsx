import { ArrowRight } from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  buttonUserInputField,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  USER_INPUT_NOTE,
  type UserInputAnswer,
  type UserInputField,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "./ui/field";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";

// A described choice is one button row, so its description stays beside its
// label and one click is still the answer. The picked row keeps the accent
// while the answer sends.
const choiceButtonClass =
  "group flex w-full cursor-pointer items-center gap-3 rounded-md border border-dashboard-border bg-dashboard-surface-raised px-3 py-2.5 text-left font-sans text-sm transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed disabled:opacity-60 data-[picked]:border-dashboard-accent/60 data-[picked]:bg-dashboard-accent/10 data-[picked]:opacity-100";

/** Sends the picks of a docked form from outside it. */
export type UserInputFormHandle = {
  /**
   * Send the picks and text. Undefined when there is nothing to send;
   * otherwise resolves false when the send fails.
   */
  sendPicks(): Promise<boolean> | undefined;
};

// Marks the choice that Junior recommends, next to its label.
function SuggestedLabel(props: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-2 text-xs font-normal text-dashboard-accent-text/80",
        props.className,
      )}
    >
      Suggested
    </span>
  );
}

// Names the number key of a docked choice. The button already says it to
// screen readers in `aria-keyshortcuts`.
function ShortcutHint(props: { value?: string }) {
  if (!props.value) return null;
  return (
    <kbd
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded border border-dashboard-border bg-dashboard-fill-soft font-sans text-2xs text-dashboard-text-muted max-md:hidden"
    >
      {props.value}
    </kbd>
  );
}

// Each choice is a choice card, so the hit area and the selected state read
// at a glance. The control inside keeps its own focus ring.
function ChoiceOption(props: {
  control: ReactNode;
  disabled: boolean;
  option: { description?: string; label: string; recommended?: boolean };
}) {
  const { option } = props;
  return (
    <FieldLabel>
      <Field
        data-disabled={props.disabled || undefined}
        orientation="horizontal"
      >
        {props.control}
        <FieldContent className="min-w-0 break-words">
          <FieldTitle>
            {option.label}
            {option.recommended ? <SuggestedLabel className="ml-0" /> : null}
          </FieldTitle>
          {option.description ? (
            <FieldDescription>{option.description}</FieldDescription>
          ) : null}
        </FieldContent>
      </Field>
    </FieldLabel>
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
  // Radios already say that one choice counts. Say it for checkboxes only.
  const legend = (
    <FieldLegend variant="label">
      {field.label}
      {field.kind === "multi_choice" ? (
        <span className="ml-2 text-xs font-normal text-dashboard-text-muted">
          Pick any
        </span>
      ) : null}
    </FieldLegend>
  );
  const description = field.description ? (
    <FieldDescription id={`${id}-help`}>{field.description}</FieldDescription>
  ) : null;
  const describedBy = field.description ? `${id}-help` : undefined;
  if (field.kind === "choice") {
    return (
      <FieldSet className="min-w-0">
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
            <ChoiceOption
              control={<RadioGroupItem value={option.label} />}
              disabled={props.disabled}
              key={option.label}
              option={option}
            />
          ))}
        </RadioGroup>
      </FieldSet>
    );
  }
  return (
    <FieldSet aria-describedby={describedBy} className="min-w-0">
      {legend}
      {description}
      <div className="grid gap-2" data-slot="checkbox-group">
        {field.options.map((option) => (
          <ChoiceOption
            control={
              <Checkbox
                checked={props.values.includes(option.label)}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  props.onChange(
                    checked
                      ? [...props.values, option.label]
                      : props.values.filter((value) => value !== option.label),
                  )
                }
              />
            }
            disabled={props.disabled}
            key={option.label}
            option={option}
          />
        ))}
      </div>
    </FieldSet>
  );
}

function TextField(props: {
  className?: string;
  description?: string;
  disabled: boolean;
  label: string;
  onChange(value: string): void;
  ref?: Ref<HTMLTextAreaElement>;
  value: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      {props.description ? (
        <FieldDescription id={`${id}-help`}>
          {props.description}
        </FieldDescription>
      ) : null}
      <Textarea
        aria-describedby={props.description ? `${id}-help` : undefined}
        className={cn("min-h-20 leading-relaxed", props.className)}
        disabled={props.disabled}
        id={id}
        onChange={(event) => props.onChange(event.target.value)}
        ref={props.ref}
        value={props.value}
      />
    </Field>
  );
}

/**
 * Render the answer controls of an action item request. A request with
 * one short choice field shows one button per choice, and a click is the
 * answer. Choices with descriptions stack as rows, so each description stays
 * with its choice. Other… turns the buttons into the form, so the reader can
 * add a note or answer in their own words. Other requests show a form that
 * the reader submits once.
 * A failed `onSubmit` lets the reader try again. `secondaryActions`, such as
 * Dismiss, sit after the answer controls. `onUnsentChange` reports whether
 * the form has picks or text that the reader has not sent.
 *
 * `docked` is for the question above the message box. The message box takes
 * the reader's own words and sends the picks, so Other…, the note, and the
 * form's Send do not show. `ref.sendPicks` sends the picks. Each choice
 * button names its number key in `aria-keyshortcuts`.
 */
export function UserInputForm(props: {
  docked?: boolean;
  onSubmit(answer: UserInputAnswer): Promise<void>;
  onUnsentChange?(unsent: boolean): void;
  ref?: Ref<UserInputFormHandle>;
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
  const [writeOther, setWriteOther] = useState(false);
  const buttonField = writeOther
    ? undefined
    : buttonUserInputField(props.request);
  // Other… unmounts the button that had focus, so move focus to the note.
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (writeOther) noteRef.current?.focus();
  }, [writeOther]);

  // A ref blocks a second click before React renders the disabled controls.
  // The lock stays after a sent answer; only a failed send can retry.
  const sendLock = useRef(false);

  async function send(answer: UserInputAnswer): Promise<boolean> {
    if (sendLock.current) return false;
    sendLock.current = true;
    setSending(true);
    setFailed(false);
    try {
      await props.onSubmit(answer);
      return true;
    } catch {
      sendLock.current = false;
      setSending(false);
      setPicked(undefined);
      setFailed(true);
      return false;
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
  const normalized = normalizeUserInputAnswer(props.request, answer);
  const answeredCount = Object.keys(normalized.values).length;
  const fieldCount = props.request.fields.length;
  // A button answer sends on click, so only the form can hold unsent input.
  const unsent =
    !buttonField && !sending && !isEmptyUserInputAnswer(normalized);
  const onUnsentChange = props.onUnsentChange;
  useEffect(() => {
    onUnsentChange?.(unsent);
  }, [onUnsentChange, unsent]);
  useImperativeHandle(props.ref, () => ({
    sendPicks: () => (unsent ? send(answer) : undefined),
  }));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!isEmptyUserInputAnswer(normalized)) {
      void send(answer);
    }
  }

  const secondary = props.secondaryActions ? (
    <div className="flex flex-wrap gap-1 sm:ml-auto">
      {props.secondaryActions}
    </div>
  ) : null;
  // Slack cards show the same button, so both surfaces take a free-text
  // answer when no choice fits.
  const otherButton = props.docked ? null : (
    <Button disabled={sending} onClick={() => setWriteOther(true)}>
      Other…
    </Button>
  );
  // Number keys pick the first nine choices.
  const shortcut = (index: number) =>
    props.docked && index < 9 ? String(index + 1) : undefined;

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
                aria-keyshortcuts={shortcut(index)}
                aria-labelledby={`${choicesId}-${index}-label`}
                className={choiceButtonClass}
                data-picked={picked === option.label ? "" : undefined}
                disabled={sending}
                key={option.label}
                onClick={() => pick(buttonField.id, option.label)}
                type="button"
              >
                <ShortcutHint value={shortcut(index)} />
                <span className="grid min-w-0 flex-1 gap-0.5 break-words">
                  <span
                    className="font-medium text-dashboard-text"
                    id={`${choicesId}-${index}-label`}
                  >
                    {option.label}
                    {option.recommended ? <SuggestedLabel /> : null}
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {otherButton}
            {secondary}
          </div>
        </>
      ) : buttonField ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {buttonField.options.map((option, index) => (
            <Button
              aria-keyshortcuts={shortcut(index)}
              disabled={sending}
              key={option.label}
              onClick={() => pick(buttonField.id, option.label)}
            >
              <ShortcutHint value={shortcut(index)} />
              {option.label}
              {/* The button gap already spaces the label. */}
              {option.recommended ? <SuggestedLabel className="ml-0" /> : null}
            </Button>
          ))}
          {otherButton}
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
          {props.docked ? null : (
            <TextField
              className="min-h-16"
              description={USER_INPUT_NOTE.description}
              disabled={sending}
              label={USER_INPUT_NOTE.label}
              onChange={setOther}
              ref={noteRef}
              value={other}
            />
          )}
          {/* A docked form sends from the message box, so this row can be
              empty there. */}
          {props.docked && fieldCount < 2 && !secondary ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {props.docked ? null : (
                <Button disabled={sending} type="submit" variant="primary">
                  Send
                </Button>
              )}
              {fieldCount > 1 ? (
                <span
                  aria-live="polite"
                  className="text-xs text-dashboard-text-muted"
                >
                  {answeredCount} of {fieldCount} answered
                </span>
              ) : null}
              {secondary}
            </div>
          )}
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
