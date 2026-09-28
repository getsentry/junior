import { useQuery } from "@tanstack/react-query";
import {
  automationEventCatalogSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import { Field } from "../../components/Field";
import { Select } from "../../components/Select";
import { TextInput } from "../../components/TextInput";
import { Button } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { fetchDashboardJson } from "../../http";

type Trigger = Extract<AutomationEdit, { kind: "event" }>["trigger"];

/** Render registered Event choices without discarding unsupported saved selectors. */
export function AutomationEventFields(props: {
  value: Trigger;
  original: Trigger;
  onChange(value: Trigger): void;
}) {
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
  const resource = catalog.data?.find(
    (item) =>
      item.namespace === props.value.namespace &&
      item.type === props.value.resourceType,
  );
  const unsupported =
    !resource ||
    props.value.events.some(
      (event) => !resource.supportedEvents.includes(event),
    ) ||
    Object.entries(props.value.match ?? {}).some(([key, value]) => {
      const field = resource.matchFields?.[key];
      if (!field) return true;
      return (Array.isArray(value) ? value : [value]).some(
        (item) =>
          typeof item !== field.kind ||
          (field.enum && !field.enum.includes(String(item))),
      );
    });
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
          <pre className="whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(props.value, null, 2)}
          </pre>
        </FormNotice>
      ) : null}
      <Field
        label={unsupported ? "Replace trigger" : "Resource type"}
        htmlFor="trigger-resource"
      >
        <Select
          id="trigger-resource"
          value={
            unsupported
              ? ""
              : `${props.value.namespace}:${props.value.resourceType}`
          }
          onChange={(e) => {
            const next = catalog.data?.find(
              (item) => `${item.namespace}:${item.type}` === e.target.value,
            );
            if (!next) return;
            if (
              !window.confirm(
                "Replace the saved trigger? Its resource, events, and conditions will be cleared.",
              )
            )
              return;
            props.onChange({
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
          {catalog.data?.map((item) => (
            <option
              key={`${item.namespace}:${item.type}`}
              value={`${item.namespace}:${item.type}`}
            >
              {item.namespace} · {item.type.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
      </Field>
      {!unsupported && resource ? (
        <>
          <Field label="Resource name" htmlFor="trigger-label">
            <TextInput
              size="comfortable"
              id="trigger-label"
              value={props.value.label}
              onChange={(e) =>
                props.onChange({ ...props.value, label: e.target.value })
              }
            />
          </Field>
          <Field
            label="Resource identifier"
            htmlFor="trigger-identifier"
            help="Use the exact provider resource identifier, not its display name."
          >
            <TextInput
              size="comfortable"
              id="trigger-identifier"
              value={props.value.identifier}
              onChange={(e) =>
                props.onChange({ ...props.value, identifier: e.target.value })
              }
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">
              Run on these events
            </legend>
            <div className="divide-y divide-dashboard-border-subtle rounded-md border border-dashboard-border-emphasis">
              {resource.supportedEvents.map((event) => (
                <label
                  key={event}
                  className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-dashboard-focus"
                    checked={props.value.events.includes(event)}
                    onChange={() =>
                      props.onChange({
                        ...props.value,
                        events: props.value.events.includes(event)
                          ? props.value.events.filter((v) => v !== event)
                          : [...props.value.events, event],
                      })
                    }
                  />
                  <span className="min-w-0 break-words">
                    {event.replaceAll("_", " ").replaceAll(".", " · ")}
                    {resource.guidance?.[event] ? (
                      <span className="mt-1 block text-xs leading-relaxed text-dashboard-text-muted">
                        {resource.guidance[event]}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {Object.keys(resource.matchFields ?? {}).length ? (
            <fieldset className="grid gap-4">
              <legend className="mb-3 text-sm font-semibold">Only when</legend>
              <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
                All conditions must match. Leave a field blank to match any
                value. Existing lists match any one listed value.
              </p>
              {Object.entries(resource.matchFields ?? {}).map(
                ([key, field]) => {
                  const value = props.value.match?.[key];
                  return (
                    <Field
                      key={key}
                      label={key}
                      htmlFor={`match-${key}`}
                      help={field.description}
                    >
                      {Array.isArray(value) ? (
                        <div className="text-sm">
                          <span className="break-all">{value.join(", ")}</span>{" "}
                          <Button onClick={() => setMatch(key, undefined)}>
                            Remove condition
                          </Button>
                        </div>
                      ) : field.kind === "boolean" || field.enum ? (
                        <Select
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
                        </Select>
                      ) : (
                        <TextInput
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
                    </Field>
                  );
                },
              )}
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
