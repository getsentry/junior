import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  describeEventTrigger,
  eventTriggerChoices,
  eventMatchFilterText,
  eventTriggerProblems,
  eventTypeText,
  eventsWithoutMatchField,
  type EventTriggerSource,
} from "@sentry/junior-plugin-api";
import {
  automationEventCatalogSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field";
import { NativeSelect } from "../../components/ui/native-select";
import { FormNotice } from "../../components/FormNotice";
import { TriggerFilters } from "./TriggerFilters";
import { Checkbox } from "../../components/ui/checkbox";
import { fetchDashboardJson } from "../../http";

type Trigger = Extract<AutomationEdit, { kind: "event" }>["trigger"];

// Select value for a trigger with no identifier, which runs for any resource.
const ANY_RESOURCE = "*";

/** Render registered Event choices without discarding unsupported saved selectors. */
export function AutomationEventFields(props: {
  value: Trigger;
  original: Trigger;
  /** Base UI checkboxes do not inherit a native fieldset's disabled state. */
  disabled?: boolean;
  onChange(value: Trigger): void;
}) {
  const [replacement, setReplacement] = useState<Trigger>();
  const catalog = useQuery({
    queryKey: ["dashboard", "automation-event-catalog"],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationEventCatalogSchema,
        "/api/automations/event-catalog",
        signal,
      ),
    retry: false,
  });
  const sourceResourceTypes =
    catalog.data?.filter((item) => item.namespace === props.value.namespace) ??
    [];
  const source: EventTriggerSource = {
    resourceTypes: sourceResourceTypes,
    anyResourceEvents: sourceResourceTypes[0]?.anyResourceEvents,
  };
  const anyResource = props.value.resourceType === undefined;
  const choices = eventTriggerChoices(source, props.value);
  const problems = catalog.data
    ? eventTriggerProblems(source, props.value)
    : [];
  // A filter that a selected event does not set, or a filter that an event
  // needs, is fixable here. Other problems mean the catalog changed after the
  // trigger was saved.
  const unsupported =
    !choices ||
    problems.some(
      (problem) =>
        problem.reason !== "field_not_set" &&
        problem.reason !== "filter_required",
    );
  const anyResourceNamespaces = [
    ...new Set(
      catalog.data
        ?.filter((item) => item.anyResourceEvents)
        .map((item) => item.namespace),
    ),
  ];
  const matchFields = Object.entries(choices?.fields ?? {});
  const shownMatchFields = matchFields.filter(
    ([key, field]) =>
      props.value.match?.[key] !== undefined ||
      eventsWithoutMatchField(field, props.value.events).length === 0,
  );
  const setMatch = (
    key: string,
    value: NonNullable<Trigger["match"]>[string] | undefined,
  ) => {
    const match = { ...props.value.match };
    if (value === undefined) delete match[key];
    else match[key] = value;
    props.onChange({ ...props.value, match });
  };
  return (
    <>
      {catalog.error ? (
        <FormNotice title="Event choices could not be loaded.">
          Saved values are kept.{" "}
          <Button onClick={() => void catalog.refetch()}>Try again</Button>
        </FormNotice>
      ) : catalog.isPending ? (
        <p role="status">Loading event choices…</p>
      ) : null}
      {unsupported && catalog.data ? (
        <FormNotice title="Saved trigger · Kept unchanged">
          Some saved values are not in the current catalog. You can edit other
          fields, or select a new resource type to replace the trigger.
          <SavedTrigger source={source} trigger={props.value} />
        </FormNotice>
      ) : null}
      <Field>
        <FieldLabel htmlFor="trigger-resource">
          {unsupported ? "Replace trigger" : "Resource type"}
        </FieldLabel>
        <NativeSelect
          id="trigger-resource"
          value={
            unsupported
              ? ""
              : `${props.value.namespace}:${props.value.resourceType ?? ANY_RESOURCE}`
          }
          onChange={(e) => {
            const [namespace, type] = e.target.value.split(":");
            if (type === ANY_RESOURCE && namespace) {
              setReplacement({ namespace, label: "", events: [] });
              return;
            }
            const next = catalog.data?.find(
              (item) => `${item.namespace}:${item.type}` === e.target.value,
            );
            if (!next) return;
            setReplacement({
              namespace: next.namespace,
              resourceType: next.type,
              identifier: "",
              label: "",
              events: [],
            });
          }}
        >
          <option value="" disabled>
            Keep saved trigger
          </option>
          {anyResourceNamespaces.map((namespace) => (
            <option
              key={`${namespace}:${ANY_RESOURCE}`}
              value={`${namespace}:${ANY_RESOURCE}`}
            >
              {namespace} · any resource
            </option>
          ))}
          {catalog.data?.map((item) => (
            <option
              key={`${item.namespace}:${item.type}`}
              value={`${item.namespace}:${item.type}`}
            >
              {item.namespace} · {item.type.replaceAll("_", " ")}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setReplacement(undefined);
        }}
        open={replacement !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Replace the saved trigger?</AlertDialogTitle>
          <AlertDialogDescription>
            Its resource, events, and filters will be cleared.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (replacement) props.onChange(replacement);
                setReplacement(undefined);
              }}
              variant="primary"
            >
              Replace trigger
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!unsupported && choices ? (
        <>
          <Field>
            <FieldLabel htmlFor="trigger-label">Resource name</FieldLabel>
            <Input
              size="comfortable"
              id="trigger-label"
              value={props.value.label}
              onChange={(e) =>
                props.onChange({ ...props.value, label: e.target.value })
              }
            />
          </Field>
          {anyResource ? (
            <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
              Runs for every resource that the filters match.
            </p>
          ) : (
            <Field>
              <FieldLabel htmlFor="trigger-identifier">
                Resource identifier
              </FieldLabel>
              <Input
                size="comfortable"
                id="trigger-identifier"
                value={props.value.identifier ?? ""}
                onChange={(e) =>
                  props.onChange({
                    ...props.value,
                    identifier: e.target.value,
                  })
                }
              />
              <FieldDescription id="trigger-identifier-help">
                Use the exact provider resource identifier, not its display
                name.
              </FieldDescription>
            </Field>
          )}
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">
              Run on these events
            </legend>
            <div className="divide-y divide-dashboard-border-subtle rounded-md border border-dashboard-border-emphasis">
              {choices.events.map((event) => (
                <label
                  key={event}
                  className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-3 text-sm"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={props.value.events.includes(event)}
                    disabled={props.disabled}
                    onCheckedChange={() =>
                      props.onChange({
                        ...props.value,
                        events: props.value.events.includes(event)
                          ? props.value.events.filter((v) => v !== event)
                          : [...props.value.events, event],
                      })
                    }
                  />
                  <span className="min-w-0 break-words">
                    {eventTypeText(event)}
                    {anyResource &&
                    source.anyResourceEvents?.[event]?.requiredFilter ? (
                      <span className="text-dashboard-text-muted">
                        {" "}
                        · needs a{" "}
                        {source.anyResourceEvents[event].requiredFilter} filter
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {matchFields.length ? (
            <fieldset className="grid gap-4">
              <legend className="mb-3 text-sm font-semibold">Filters</legend>
              <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
                Every filter must match. Leave a filter blank to match any
                value.
                {shownMatchFields.length < matchFields.length
                  ? " Filters that a selected event does not set are hidden."
                  : null}
              </p>
              {shownMatchFields.map(([key, field]) => {
                const value = props.value.match?.[key];
                const problem = problems.find(
                  (candidate) => candidate.field === key,
                );
                return (
                  <Field key={key}>
                    <FieldLabel htmlFor={`match-${key}`}>{key}</FieldLabel>
                    {Array.isArray(value) ? (
                      <div className="text-sm">
                        <span className="break-all">
                          {eventMatchFilterText(key, field, value)}
                        </span>{" "}
                        <Button onClick={() => setMatch(key, undefined)}>
                          Remove filter
                        </Button>
                      </div>
                    ) : field.kind === "boolean" || field.enum ? (
                      <NativeSelect
                        id={`match-${key}`}
                        value={value === undefined ? "" : String(value)}
                        onChange={(e) =>
                          setMatch(
                            key,
                            e.target.value === ""
                              ? undefined
                              : field.kind === "boolean"
                                ? e.target.value === "true"
                                : e.target.value,
                          )
                        }
                      >
                        <option value="">Any value</option>
                        {(field.enum ?? ["true", "false"]).map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input
                        size="comfortable"
                        id={`match-${key}`}
                        type={field.kind === "number" ? "number" : "text"}
                        step="any"
                        value={value === undefined ? "" : String(value)}
                        onChange={(e) =>
                          setMatch(
                            key,
                            e.target.value === ""
                              ? undefined
                              : field.kind === "number"
                                ? e.target.valueAsNumber
                                : e.target.value,
                          )
                        }
                      />
                    )}
                    {field.description ? (
                      <FieldDescription id={`match-${key}-help`}>
                        {field.description}
                      </FieldDescription>
                    ) : null}
                    {problem ? (
                      <FieldError>{problem.message}</FieldError>
                    ) : null}
                  </Field>
                );
              })}
            </fieldset>
          ) : null}
        </>
      ) : null}
      {JSON.stringify(props.value) !== JSON.stringify(props.original) ? (
        <Button
          className="w-fit"
          onClick={() => props.onChange(props.original)}
        >
          Keep saved trigger
        </Button>
      ) : null}
    </>
  );
}

/** Show the saved trigger and its problems in the same words as the details. */
function SavedTrigger(props: { source: EventTriggerSource; trigger: Trigger }) {
  const description = describeEventTrigger(props.source, props.trigger);
  return (
    <>
      <ul className="my-2 list-disc pl-5">
        {description.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <div className="text-xs">
        <p className="m-0 break-words">
          {props.trigger.namespace} ·{" "}
          {props.trigger.resourceType?.replaceAll("_", " ") ?? "any resource"}
          {props.trigger.identifier ? ` · ${props.trigger.identifier}` : null}
        </p>
        <p className="m-0 mt-1 break-words text-dashboard-text-muted">
          {description.events.join(", ")}
        </p>
        <TriggerFilters filters={description.filters} />
      </div>
    </>
  );
}
