import { useState } from "react";
import {
  buildEventIdentifier,
  parseEventIdentifier,
  type EventIdentifierParts,
  type EventIdentifierFormat,
} from "@sentry/junior-plugin-api";
import { Input } from "../../components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field";
import { NativeSelect } from "../../components/ui/native-select";
import { FormNotice } from "../../components/FormNotice";

/**
 * Edit an event identifier one part at a time.
 *
 * The trigger keeps the exact identifier string. A part value that does not
 * fit clears the string, so the save cannot send a wrong identifier.
 */
export function AutomationIdentifierFields(props: {
  format: EventIdentifierFormat;
  value: string;
  onChange(value: string): void;
}) {
  // Parts that do not build an identifier exist only here. Use them while the
  // trigger still has the string they built; a reset or replace changes it.
  const [draft, setDraft] = useState<{
    identifier: string;
    parts: EventIdentifierParts;
  }>();
  const saved = parseEventIdentifier(props.format, props.value);
  const edited = draft?.identifier === props.value ? draft : undefined;
  const parts = edited?.parts ?? (saved.ok ? saved.parts : {});
  const built = buildEventIdentifier(props.format, parts);
  const problems = edited && !built.ok ? built.problems : [];
  const setPart = (name: string, value: string) => {
    const next = { ...parts, [name]: value };
    const result = buildEventIdentifier(props.format, next);
    const identifier = result.ok ? result.identifier : "";
    setDraft({ identifier, parts: next });
    props.onChange(identifier);
  };
  return (
    <fieldset className="grid gap-4">
      <legend className="mb-3 text-sm font-semibold">
        Resource identifier
      </legend>
      {!edited && props.value && !saved.ok ? (
        <FormNotice title="Saved identifier does not fit">
          “{props.value}” does not have the form “{props.format.template}”.{" "}
          {saved.problems.map((problem) => problem.message).join(" ")} Enter
          each part to replace it.
        </FormNotice>
      ) : (
        <p className="m-0 break-all text-xs leading-relaxed text-dashboard-text-muted">
          Form: <code>{props.format.template}</code>
          {built.ok ? (
            <>
              {" "}
              · Identifier: <code>{built.identifier}</code>
            </>
          ) : null}
        </p>
      )}
      {Object.entries(props.format.parts).map(([name, part]) => {
        const problem = problems.find((candidate) => candidate.part === name);
        const id = `identifier-${name}`;
        const describedBy = [`${id}-help`, problem ? `${id}-error` : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <Field key={name}>
            <FieldLabel htmlFor={id}>{name}</FieldLabel>
            {part.enum ? (
              <NativeSelect
                id={id}
                aria-describedby={describedBy}
                aria-invalid={Boolean(problem) || undefined}
                value={parts[name] ?? ""}
                onChange={(e) => setPart(name, e.target.value)}
              >
                <option value="">None</option>
                {part.enum.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                size="comfortable"
                id={id}
                aria-describedby={describedBy}
                aria-invalid={Boolean(problem) || undefined}
                inputMode={part.kind === "number" ? "numeric" : undefined}
                value={parts[name] ?? ""}
                onChange={(e) => setPart(name, e.target.value)}
              />
            )}
            <FieldDescription id={`${id}-help`}>
              {part.description}
            </FieldDescription>
            {problem ? (
              <FieldError id={`${id}-error`}>{problem.message}</FieldError>
            ) : null}
          </Field>
        );
      })}
    </fieldset>
  );
}
