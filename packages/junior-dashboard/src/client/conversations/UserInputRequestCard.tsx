import { useId, useState, type FormEvent } from "react";
import {
  buttonUserInputField,
  formatUserInputAnswer,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputField,
} from "@sentry/junior/api/schema";

import { Button } from "../components/Button";
import { TextArea } from "../components/TextInput";
import { TranscriptText } from "./TranscriptText";
import type { OpenUserInputRequest } from "./userInputRequest";

const labelClass = "font-sans text-xs font-medium text-dashboard-text-muted";

function ChoiceField(props: {
  disabled: boolean;
  field: Extract<UserInputField, { kind: "choice" | "multi_choice" }>;
  onChange(values: string[]): void;
  values: string[];
}) {
  const name = useId();
  const multi = props.field.kind === "multi_choice";
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className={labelClass}>{props.field.label}</legend>
      {props.field.description ? (
        <p className="m-0 text-xs text-dashboard-text-muted">
          {props.field.description}
        </p>
      ) : null}
      <div className="mt-1 grid gap-1">
        {props.field.options.map((option) => (
          <label
            className="flex cursor-pointer items-start gap-2 text-sm"
            key={option.label}
          >
            <input
              checked={props.values.includes(option.label)}
              className="mt-0.5 size-4 shrink-0 accent-dashboard-focus"
              disabled={props.disabled}
              name={name}
              onChange={() =>
                props.onChange(
                  !multi
                    ? [option.label]
                    : props.values.includes(option.label)
                      ? props.values.filter((value) => value !== option.label)
                      : [...props.values, option.label],
                )
              }
              type={multi ? "checkbox" : "radio"}
            />
            <span className="min-w-0 break-words">
              {option.label}
              {option.description ? (
                <span className="block text-xs text-dashboard-text-muted">
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TextField(props: {
  description?: string;
  disabled: boolean;
  label: string;
  onChange(value: string): void;
  value: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label className={labelClass} htmlFor={id}>
        {props.label}
      </label>
      {props.description ? (
        <p className="m-0 text-xs text-dashboard-text-muted">
          {props.description}
        </p>
      ) : null}
      <TextArea
        className="min-h-16"
        disabled={props.disabled}
        id={id}
        onChange={(event) => props.onChange(event.target.value)}
        prose
        value={props.value}
      />
    </div>
  );
}

/**
 * Show Junior's open request above the composer. A request with one short
 * choice field shows one button per choice, and a click is the answer. Other
 * requests show a form that the reader submits once. Both send the formatted
 * answer as the reader's next message. Typing a reply also answers it.
 */
export function UserInputRequestCard(props: {
  onAnswer(answer: string): Promise<void>;
  request: OpenUserInputRequest;
}) {
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");
  const buttonField = buttonUserInputField(props.request);

  async function send(answer: UserInputAnswer) {
    setSending(true);
    setFailed(false);
    try {
      await props.onAnswer(formatUserInputAnswer(props.request, answer));
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  const answer: UserInputAnswer = {
    other,
    requestId: props.request.toolCallId,
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

  return (
    <section
      aria-label="Junior asks"
      className="mb-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-3 py-2.5 font-sans text-sm text-dashboard-text"
    >
      <div className="max-h-48 overflow-y-auto">
        <TranscriptText role="assistant" text={props.request.question} />
      </div>
      {buttonField ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {buttonField.options.map((option) => (
              <Button
                disabled={sending}
                key={option.label}
                onClick={() =>
                  void send({
                    requestId: props.request.toolCallId,
                    values: { [buttonField.id]: [option.label] },
                  })
                }
                title={option.description}
              >
                {option.label}
              </Button>
            ))}
          </div>
          {buttonField.options.some((option) => option.description) ? (
            <ul className="mb-0 mt-2 list-none p-0 text-xs text-dashboard-text-muted">
              {buttonField.options
                .filter((option) => option.description)
                .map((option) => (
                  <li key={option.label}>
                    <span className="font-medium text-dashboard-text">
                      {option.label}
                    </span>
                    : {option.description}
                  </li>
                ))}
            </ul>
          ) : null}
        </>
      ) : (
        <form
          className="mt-2 grid max-h-96 gap-3 overflow-y-auto"
          onSubmit={submit}
        >
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
            description="Anything else, or an answer that is not listed."
            disabled={sending}
            label="Other"
            onChange={setOther}
            value={other}
          />
          <div>
            <Button disabled={sending} tone="primary" type="submit">
              Send
            </Button>
          </div>
        </form>
      )}
      {failed ? (
        <p className="mb-0 mt-2 text-xs text-rose-300" role="alert">
          Could not send your answer. Try again.
        </p>
      ) : null}
    </section>
  );
}
