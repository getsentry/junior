import { Check } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  buttonUserInputField,
  type ActorIdentity,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  USER_INPUT_NOTE,
  USER_INPUT_OTHER_LABEL,
  type UserInputAnswer,
  type UserInputField,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { readAnswerDraft, saveAnswerDraft } from "./answerDrafts";
import { useInBottomSheet } from "./bottomSheetContext";
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

// In a sheet, the actions stay on its bottom edge while the fields scroll
// under them.
const SHEET_ACTIONS_CLASS =
  "sticky bottom-0 z-10 bg-dashboard-bg-elevated pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-0.75rem_0.75rem_-0.75rem_var(--color-dashboard-overlay-soft)]";

// A described choice is one button row, so its description stays beside its
// label. The picked row keeps the accent while the answer sends.
const choiceButtonClass =
  "group flex w-full cursor-pointer items-center gap-3 rounded-md border border-dashboard-border bg-dashboard-surface-raised px-3 py-2.5 text-left font-sans text-sm transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed disabled:opacity-60 data-[picked]:border-dashboard-accent/60 data-[picked]:bg-dashboard-accent/10 data-[picked]:opacity-100";

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

// Enter adds a line, as in every text box that takes more than one line.
// Cmd or Ctrl with Enter sends the form.
function sendOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

// Text that the agent wrote for a question, with its mentions resolved.
function QuestionText(props: {
  mentions: readonly ActorIdentity[] | undefined;
  text: string;
}) {
  return <DisplayText inline mentions={props.mentions} text={props.text} />;
}

// The Other choice of a question: the person's own answer. Typing in it
// replaces the pick of a single choice question.
function OtherInput(props: {
  disabled: boolean;
  label: string;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <Textarea
      aria-label={`${props.label}: ${USER_INPUT_OTHER_LABEL}`}
      className="min-h-9 py-1.5"
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={sendOnModEnter}
      placeholder={USER_INPUT_OTHER_LABEL}
      rows={1}
      value={props.value}
    />
  );
}

// Each choice is a choice card, so the hit area and the selected state read
// at a glance. The control inside keeps its own focus ring.
function ChoiceOption(props: {
  control: ReactNode;
  option: {
    description?: string | undefined;
    label: string;
    recommended?: boolean | undefined;
  };
}) {
  const { option } = props;
  return (
    <FieldLabel>
      <Field orientation="horizontal">
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
  custom?: { onChange(value: string): void; value: string } | undefined;
  disabled: boolean;
  field: Extract<UserInputField, { kind: "choice" | "multi_choice" }>;
  mentions: readonly ActorIdentity[] | undefined;
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
    <FieldDescription id={`${id}-help`}>
      <QuestionText mentions={props.mentions} text={field.description} />
    </FieldDescription>
  ) : null;
  const other = props.custom ? (
    <OtherInput
      disabled={props.disabled}
      label={field.label}
      onChange={props.custom.onChange}
      value={props.custom.value}
    />
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
              key={option.label}
              option={option}
            />
          ))}
        </RadioGroup>
        {other}
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
            key={option.label}
            option={option}
          />
        ))}
      </div>
      {other}
    </FieldSet>
  );
}

function TextField(props: {
  className?: string;
  description?: string | undefined;
  disabled: boolean;
  label: string;
  mentions?: readonly ActorIdentity[] | undefined;
  onChange(value: string): void;
  value: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      {props.description ? (
        <FieldDescription id={`${id}-help`}>
          <QuestionText mentions={props.mentions} text={props.description} />
        </FieldDescription>
      ) : null}
      <Textarea
        aria-describedby={props.description ? `${id}-help` : undefined}
        className={cn("min-h-20 leading-relaxed", props.className)}
        disabled={props.disabled}
        id={id}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={sendOnModEnter}
        value={props.value}
      />
    </Field>
  );
}

/**
 * Render the answer controls of an action item request: one button per
 * choice for a single short choice field, otherwise every field, then the
 * additional notes. `custom` adds Other to each choice question. `draft`, or
 * else the unsent answers saved by `requestId`, fills the form on mount.
 */
export function UserInputForm(props: {
  /** Each choice question takes the reader's own answer too. */
  custom?: boolean;
  /** An answer to start from, such as one that failed to send. */
  draft?: Pick<UserInputAnswer, "custom" | "other" | "values">;
  /** People that the question text mentions. */
  mentions?: readonly ActorIdentity[] | undefined;
  onSubmit(answer: UserInputAnswer): Promise<void>;
  onUnsentChange?(unsent: boolean): void;
  request: UserInputRequest;
  requestId: string;
  secondaryActions?: ReactNode;
  /** False when the answer takes no words, so the form has no note. */
  words?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const choiceField = buttonUserInputField(props.request);
  // A plugin action sends on click. It reads no words, so it has no note.
  const actionField =
    choiceField && (props.words === false || choiceField.options.length === 1)
      ? choiceField
      : undefined;
  // A failed action comes back with its choice marked.
  const [clicked, setClicked] = useState(
    () => actionField && props.draft?.values[actionField.id]?.[0],
  );
  const [failed, setFailed] = useState(false);
  const choicesId = useId();
  const [draft] = useState(() =>
    props.draft
      ? {
          custom: props.draft.custom ?? {},
          other: props.draft.other ?? "",
          values: props.draft.values,
        }
      : readAnswerDraft(props.requestId),
  );
  const [values, setValues] = useState(draft.values);
  const [custom, setCustom] = useState(draft.custom);
  const [other, setOther] = useState(draft.other);

  function changeValues(fieldId: string, fieldValues: string[]) {
    setValues((current) => ({ ...current, [fieldId]: fieldValues }));
    saveAnswerDraft(props.requestId, { values: { [fieldId]: fieldValues } });
  }
  function changeCustom(fieldId: string, text: string) {
    setCustom((current) => ({ ...current, [fieldId]: text }));
    saveAnswerDraft(props.requestId, { custom: { [fieldId]: text } });
  }
  // A single choice question has one answer: a pick or the reader's own.
  function pick(field: UserInputField, fieldValues: string[]) {
    changeValues(field.id, fieldValues);
    if (field.kind === "choice" && fieldValues.length && custom[field.id]) {
      changeCustom(field.id, "");
    }
  }
  function write(field: UserInputField, text: string) {
    changeCustom(field.id, text);
    if (field.kind === "choice" && text.trim() && values[field.id]?.length) {
      changeValues(field.id, []);
    }
  }
  const customOf = (field: UserInputField) =>
    props.custom
      ? {
          onChange: (text: string) => write(field, text),
          value: custom[field.id] ?? "",
        }
      : undefined;
  function changeOther(next: string) {
    setOther(next);
    saveAnswerDraft(props.requestId, { other: next });
  }

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
      setClicked(undefined);
      setFailed(true);
    }
  }

  /** Send one action as the whole answer. */
  function act(fieldId: string, label: string) {
    setClicked(label);
    void send({ requestId: props.requestId, values: { [fieldId]: [label] } });
  }

  const answer: UserInputAnswer = {
    ...(props.custom ? { custom } : undefined),
    other,
    requestId: props.requestId,
    values,
  };
  const normalized = normalizeUserInputAnswer(props.request, answer);
  const empty = isEmptyUserInputAnswer(normalized);
  const answeredCount = props.request.fields.filter(
    (field) => normalized.values[field.id] || normalized.custom?.[field.id],
  ).length;
  const fieldCount = props.request.fields.length;
  // An action sends on click, so only the form can hold unsent input.
  const unsent = !actionField && !sending && !empty;
  const onUnsentChange = props.onUnsentChange;
  useEffect(() => {
    onUnsentChange?.(unsent);
  }, [onUnsentChange, unsent]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!empty) void send(normalized);
  }

  const inSheet = useInBottomSheet();
  const secondary = props.secondaryActions ? (
    <div className="flex flex-wrap gap-1">{props.secondaryActions}</div>
  ) : null;
  const failure = failed ? (
    <p className="mb-0 mt-2 text-xs text-rose-300" role="alert">
      Could not send your answer. Try again.
    </p>
  ) : null;

  if (actionField) {
    return (
      <>
        {/* The options are the main actions, so they end the row. */}
        <div
          className={cn(
            "flex flex-wrap items-center justify-end gap-2",
            inSheet && SHEET_ACTIONS_CLASS,
          )}
        >
          {secondary}
          {actionField.options.map((option) => (
            <Button
              data-picked={clicked === option.label ? "" : undefined}
              disabled={sending}
              key={option.label}
              onClick={() => act(actionField.id, option.label)}
              variant="outline"
            >
              {option.label}
              {/* The button gap already spaces the label. */}
              {option.recommended ? <SuggestedLabel className="ml-0" /> : null}
            </Button>
          ))}
        </div>
        {failure}
      </>
    );
  }

  const picked = choiceField ? values[choiceField.id]?.[0] : undefined;
  // A second click on the picked choice takes the pick back.
  const toggle = (field: UserInputField, label: string) =>
    pick(field, picked === label ? [] : [label]);
  const choiceOther = choiceField ? customOf(choiceField) : undefined;
  const described = choiceField?.options.some((option) => option.description);
  return (
    <form
      className={cn("grid", choiceField ? "gap-3" : "gap-5")}
      onSubmit={submit}
    >
      {choiceField ? (
        <>
          <div
            aria-label={choiceField.label}
            className={described ? "grid gap-2" : "flex flex-wrap gap-2"}
            role="group"
          >
            {choiceField.options.map((option, index) =>
              described ? (
                <button
                  aria-describedby={
                    option.description ? `${choicesId}-${index}` : undefined
                  }
                  aria-labelledby={`${choicesId}-${index}-label`}
                  aria-pressed={picked === option.label}
                  className={choiceButtonClass}
                  data-picked={picked === option.label ? "" : undefined}
                  disabled={sending}
                  key={option.label}
                  onClick={() => toggle(choiceField, option.label)}
                  type="button"
                >
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
                  <Check
                    aria-hidden="true"
                    className="shrink-0 text-dashboard-accent-text opacity-0 group-data-[picked]:opacity-100"
                    size={16}
                  />
                </button>
              ) : (
                <Button
                  aria-pressed={picked === option.label}
                  className="data-[picked]:border-dashboard-accent/60 data-[picked]:bg-dashboard-accent/10"
                  data-picked={picked === option.label ? "" : undefined}
                  disabled={sending}
                  key={option.label}
                  onClick={() => toggle(choiceField, option.label)}
                  variant="outline"
                >
                  {option.label}
                  {option.recommended ? (
                    <SuggestedLabel className="ml-0" />
                  ) : null}
                </Button>
              ),
            )}
          </div>
          {choiceOther ? (
            <OtherInput
              disabled={sending}
              label={choiceField.label}
              onChange={choiceOther.onChange}
              value={choiceOther.value}
            />
          ) : null}
        </>
      ) : (
        props.request.fields.map((field) =>
          field.kind === "text" ? (
            <TextField
              description={field.description}
              disabled={sending}
              key={field.id}
              label={field.label}
              mentions={props.mentions}
              onChange={(value) => changeValues(field.id, [value])}
              value={values[field.id]?.[0] ?? ""}
            />
          ) : (
            <ChoiceField
              custom={customOf(field)}
              disabled={sending}
              field={field}
              key={field.id}
              mentions={props.mentions}
              onChange={(next) => pick(field, next)}
              values={values[field.id] ?? []}
            />
          ),
        )
      )}
      {/* Every question card has the same notes box. */}
      <TextField
        className="min-h-16"
        description={USER_INPUT_NOTE.description}
        disabled={sending}
        label={USER_INPUT_NOTE.label}
        onChange={changeOther}
        value={other}
      />
      {/* Send is the main action, so it ends the row, on the right. */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-end gap-2",
          inSheet && SHEET_ACTIONS_CLASS,
        )}
      >
        {/* The actions stay on one row, also on a phone. */}
        <div className="flex items-center gap-1">
          {secondary}
          <SendButton disabled={sending || empty} />
        </div>
      </div>
      {/* Progress is not an action, so it goes under the actions row. */}
      {fieldCount > 1 ? (
        <p
          aria-live="polite"
          className="m-0 -mt-1 text-right text-xs text-dashboard-text-muted"
        >
          {answeredCount} of {fieldCount} answered
        </p>
      ) : null}
      {failure}
    </form>
  );
}

function SendButton(props: { disabled: boolean }) {
  return (
    <Button disabled={props.disabled} type="submit" variant="default">
      Send
    </Button>
  );
}
