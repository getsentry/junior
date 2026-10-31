import { useId, useRef, useState, type FormEvent } from "react";
import {
  buttonUserInputField,
  isEmptyUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputField,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

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
      <Textarea
        className="min-h-16 leading-relaxed"
        disabled={props.disabled}
        id={id}
        onChange={(event) => props.onChange(event.target.value)}
        value={props.value}
      />
    </div>
  );
}

/**
 * Render the answer controls of a `requestUserInput` request. A request with
 * one short choice field shows one button per choice, and a click is the
 * answer. Other requests show a form that the reader submits once. A failed
 * `onSubmit` lets the reader try again.
 */
export function UserInputForm(props: {
  onSubmit(answer: UserInputAnswer): Promise<void>;
  request: UserInputRequest;
  requestId: string;
}) {
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
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
      setFailed(true);
    }
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

  return (
    <>
      {buttonField ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {buttonField.options.map((option) => (
              <Button
                disabled={sending}
                key={option.label}
                onClick={() =>
                  void send({
                    requestId: props.requestId,
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
        <form className="mt-2 grid gap-3" onSubmit={submit}>
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
            <Button disabled={sending} type="submit" variant="primary">
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
    </>
  );
}
