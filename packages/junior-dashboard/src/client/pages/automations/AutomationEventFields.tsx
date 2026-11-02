import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  anyResourceEvents,
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
import {
  automationTriggerEdit,
  type AutomationTriggerEdit,
} from "./automationDraft";

type SavedTrigger = Extract<AutomationEdit, { kind: "event" }>["trigger"];

const NO_SOURCE: EventTriggerSource = {
  resourceTypes: [],
  events: {},
  anyResourceFields: {},
};

/**
 * Say which filter an event needs, with the filter descriptions, such as
 * "needs a filter: lowercase repository".
 */
function reachText(
  source: EventTriggerSource,
  eventType: string,
): string | undefined {
  const reach = source.events[eventType]?.reach;
  if (typeof reach !== "object") return undefined;
  const filters = reach.anyOf.map(
    (key) => source.anyResourceFields[key]?.description ?? key,
  );
  return filters.length === 1
    ? `needs a filter: ${filters[0]}`
    : `needs one of these filters: ${filters.join("; or ")}`;
}

/**
 * Render registered Event choices without discarding unsupported saved
 * selectors. A saved trigger with an identifier can only be kept or replaced
 * whole: editing its events or filters without the identifier would make it
 * broader.
 */
export function AutomationEventFields(props: {
  value: AutomationTriggerEdit;
  original: SavedTrigger;
  /** Base UI checkboxes do not inherit a native fieldset's disabled state. */
  disabled?: boolean;
  onChange(value: AutomationTriggerEdit): void;
}) {
  const [replacement, setReplacement] = useState<AutomationTriggerEdit>();
  const saved = automationTriggerEdit(props.original);
  const kept = JSON.stringify(props.value) === JSON.stringify(saved);
  const legacy = kept && props.original.identifier !== undefined;
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
  const entry = catalog.data?.find(
    (item) => item.namespace === props.value.namespace,
  );
  const source: EventTriggerSource = entry ?? NO_SOURCE;
  const displayName = entry?.displayName ?? props.value.namespace;
  // A trigger in an edit has no resource type, so it gets the filters of
  // every resource type.
  const choices = eventTriggerChoices(source, {});
  const problems = catalog.data
    ? eventTriggerProblems(source, props.value)
    : [];
  // A filter that a selected event does not set, or a filter that an event
  // needs, is fixable here. Other problems mean the catalog changed after the
  // trigger was saved.
  const unsupported =
    !choices ||
    legacy ||
    problems.some(
      (problem) =>
        problem.reason !== "field_not_set" &&
        problem.reason !== "filter_required",
    );
  const anyResourceSources =
    catalog.data?.filter((item) => anyResourceEvents(item).length > 0) ?? [];
  const matchFields = Object.entries(choices?.fields ?? {});
  const shownMatchFields = matchFields.filter(
    ([key, field]) =>
      props.value.match?.[key] !== undefined ||
      eventsWithoutMatchField(field, props.value.events).length === 0,
  );
  const setMatch = (
    key: string,
    value: NonNullable<AutomationTriggerEdit["match"]>[string] | undefined,
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
          {legacy
            ? "This trigger names one resource. An upgrade turns it into filters. Until then, you can edit other fields, or select a source to replace the trigger."
            : "Some saved values are not in the current catalog. You can edit other fields, or select a source to replace the trigger."}
          <SavedTriggerSummary
            displayName={displayName}
            source={source}
            trigger={kept ? props.original : props.value}
          />
        </FormNotice>
      ) : null}
      <Field>
        <FieldLabel htmlFor="trigger-source">
          {unsupported ? "Replace trigger" : "Source"}
        </FieldLabel>
        <NativeSelect
          id="trigger-source"
          value={unsupported ? "" : props.value.namespace}
          onChange={(e) => {
            const namespace = e.target.value;
            if (namespace) setReplacement({ namespace, label: "", events: [] });
          }}
        >
          <option value="" disabled>
            Keep saved trigger
          </option>
          {anyResourceSources.map((item) => (
            <option key={item.namespace} value={item.namespace}>
              {item.displayName}
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
            Its events and filters will be cleared.
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
            <FieldLabel htmlFor="trigger-label">Trigger name</FieldLabel>
            <Input
              size="comfortable"
              id="trigger-label"
              value={props.value.label}
              onChange={(e) =>
                props.onChange({ ...props.value, label: e.target.value })
              }
            />
          </Field>
          <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
            Runs for every resource that the filters match.
          </p>
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
                    {reachText(source, event) ? (
                      <span className="text-dashboard-text-muted">
                        {" "}
                        · {reachText(source, event)}
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
      {!kept ? (
        <Button className="w-fit" onClick={() => props.onChange(saved)}>
          Keep saved trigger
        </Button>
      ) : null}
    </>
  );
}

/** Show the saved trigger and its problems in the same words as the details. */
function SavedTriggerSummary(props: {
  displayName: string;
  source: EventTriggerSource;
  trigger: SavedTrigger;
}) {
  const { resourceType, identifier } = props.trigger;
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
          {props.displayName} ·{" "}
          {resourceType?.replaceAll("_", " ") ?? "any resource"}
          {identifier ? ` · ${identifier}` : null}
        </p>
        <p className="m-0 mt-1 break-words text-dashboard-text-muted">
          {description.events.join(", ")}
        </p>
        <TriggerFilters filters={description.filters} />
      </div>
    </>
  );
}
