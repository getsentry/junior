/** Owns one unsaved draft. Query refreshes must never replace it. */
import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  automationUpdateSchema,
  type AutomationEdit,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { Field } from "../../components/Field";
import { TextArea, TextInput } from "../../components/TextInput";
import { Button } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { DashboardApiError, fetchDashboardJson, patch } from "../../http";
import { AutomationFormSection } from "./AutomationFormSection";
import { AutomationScheduleFields } from "./AutomationScheduleFields";
import { AutomationEventFields } from "./AutomationEventFields";
import { AutomationVisibilityFields } from "./AutomationVisibilityFields";
import {
  AutomationOutcomeFields,
  AutomationOutcomeList,
} from "./AutomationOutcomeFields";
import {
  automationDraftChanges,
  createAutomationDraft,
  scheduleDraft,
  type AutomationDraft,
} from "./automationDraft";

/** Headings for edit fields whose key is not a readable label. */
const CHANGE_LABELS: Partial<Record<string, string>> = {
  credentialMode: "Credentials",
  visibility: "Who can see it",
};

/** Keep edits until the user saves or discards them. */
export function AutomationEditor(props: {
  automation: AutomationEdit;
  summary: AutomationSummary;
  returnPath: string;
}) {
  const [original, setOriginal] = useState(props.automation);
  const [draft, setDraft] = useState(() =>
    createAutomationDraft(props.automation),
  );
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [latest, setLatest] = useState<AutomationEdit>();
  const form = useRef<HTMLFormElement>(null);
  const allowLeave = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const changes = automationDraftChanges(original, draft);
  const dirty = Object.keys(changes).length > 0;
  const update = {
    kind: original.kind,
    revision: original.revision,
    ...changes,
  };
  const blocker = useBlocker(() => dirty && !allowLeave.current);
  const discardNotice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (blocker.state === "blocked") discardNotice.current?.focus();
  }, [blocker.state]);
  const url = `/api/automations/${original.kind}/${encodeURIComponent(original.id)}`;
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty && !allowLeave.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const focusError = () =>
    requestAnimationFrame(() =>
      (
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        form.current?.querySelector<HTMLElement>("[data-save-error]")
      )?.focus(),
    );
  const save = useMutation({
    mutationFn: () => patch(automationEditSchema, url, update),
    onSuccess: async () => {
      allowLeave.current = true;
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
      navigate(props.returnPath, { state: { automationSaved: true } });
    },
    onError: (error) => {
      setFields(error instanceof DashboardApiError ? (error.fields ?? {}) : {});
      focusError();
    },
  });
  function acceptLatest(keepChanges: boolean) {
    if (!latest) return;
    setDraft(
      keepChanges
        ? { ...createAutomationDraft(latest), ...changes }
        : createAutomationDraft(latest),
    );
    setOriginal(latest);
    setLatest(undefined);
    save.reset();
    setFields({});
  }
  const review = useMutation({
    mutationFn: () => fetchDashboardJson(automationEditSchema, `${url}/edit`),
    onSuccess: setLatest,
  });
  const conflict =
    save.error instanceof DashboardApiError && save.error.code === "conflict";
  const change = (value: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...value }));
  const fieldError = (key: string) =>
    Object.entries(fields)
      .filter(([name]) => name === key || name.startsWith(`${key}.`))
      .flatMap(([, messages]) => messages)
      .join(" ") || undefined;
  const triggerField = original.kind === "scheduled" ? "schedule" : "trigger";
  const owned = original.ownedByViewer;
  const creator = props.summary.createdBy;
  // Core switches a non-creator's execution change to system credentials.
  const dropsCreatorCredentials =
    !owned &&
    original.credentialMode === "creator" &&
    (changes.instruction !== undefined ||
      (original.kind === "event" && changes.trigger !== undefined));
  const triggerError = fieldError(triggerField);
  const inputState = (key: string) => ({
    "aria-invalid": Boolean(fieldError(key)) || undefined,
    "aria-describedby": fieldError(key) ? `${key}-error` : undefined,
  });
  return (
    <form
      ref={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending || conflict || !dirty) return;
        const parsed = automationUpdateSchema.safeParse(update);
        if (!parsed.success) {
          const errors: Record<string, string[]> = {};
          for (const issue of parsed.error.issues)
            (errors[issue.path.join(".")] ??= []).push(issue.message);
          setFields(errors);
          focusError();
          return;
        }
        setFields({});
        save.mutate();
      }}
    >
      {blocker.state === "blocked" ? (
        <div tabIndex={-1} ref={discardNotice} className="mb-6 outline-none">
          <FormNotice title="Discard unsaved changes?">
            <p>Your changes have not been saved.</p>
            <div className="flex gap-2">
              <Button onClick={() => blocker.reset()}>Keep editing</Button>
              <Button onClick={() => blocker.proceed()}>Discard changes</Button>
            </div>
          </FormNotice>
        </div>
      ) : null}
      {save.error || Object.keys(fields).length ? (
        <div tabIndex={-1} data-save-error className="mb-6 outline-none">
          <FormNotice
            tone={conflict ? "warning" : "error"}
            title={
              conflict
                ? "This automation changed while you were editing."
                : "Changes could not be saved."
            }
          >
            <p className="mt-1">
              Your edits are still here.{" "}
              {conflict
                ? "Review the latest version before saving again."
                : save.error instanceof DashboardApiError
                  ? save.error.apiError
                  : "Check the fields below, or try again."}
            </p>
            {conflict ? (
              <Button
                disabled={review.isPending}
                onClick={() => review.mutate()}
              >
                {review.isPending ? "Loading…" : "Review latest version"}
              </Button>
            ) : null}
            {review.error ? (
              <p role="alert">
                The latest version could not be loaded. Try again.
              </p>
            ) : null}
          </FormNotice>
        </div>
      ) : null}
      {latest ? (
        <div className="mb-6">
          <FormNotice title="Compare your edits with the latest saved version">
            <p>
              Only the fields you changed are shown. Keeping your edits will
              replace these fields. Other saved fields stay unchanged.
            </p>
            {Object.entries(changes).map(([key, value]) => (
              <section key={key} className="my-4">
                <h3 className="text-sm font-semibold capitalize">
                  {CHANGE_LABELS[key] ?? key}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p>Latest saved</p>
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                      {formatEditValue(
                        key === "schedule" && latest.kind === "scheduled"
                          ? scheduleDraft(latest)
                          : latest[key as keyof AutomationEdit],
                      )}
                    </pre>
                  </div>
                  <div>
                    <p>Your edit</p>
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                      {formatEditValue(value)}
                    </pre>
                  </div>
                </div>
              </section>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => acceptLatest(true)}>
                Keep my changed fields
              </Button>
              <Button onClick={() => acceptLatest(false)}>
                Use latest saved version
              </Button>
            </div>
          </FormNotice>
        </div>
      ) : null}
      {owned ? null : (
        <p className="mt-0 mb-6 max-w-2xl text-sm leading-relaxed text-dashboard-text-muted">
          {creator} created this automation. You can edit it because it is
          public. Only {creator} can change where results go, change who can see
          it, or turn on their connected accounts. Version history keeps every
          saved change.
        </p>
      )}
      <fieldset disabled={save.isPending} className="min-w-0">
        <AutomationFormSection
          title="What to do"
          detail="Give Junior a clear instruction and a name you can find later."
        >
          <Field label="Title" htmlFor="title" error={fieldError("title")}>
            <TextInput
              size="comfortable"
              id="title"
              value={draft.title}
              placeholder={props.summary.title}
              onChange={(e) => change({ title: e.target.value })}
              {...inputState("title")}
            />
          </Field>
          <Field
            label="Instruction"
            htmlFor="instruction"
            error={fieldError("instruction")}
          >
            <TextArea
              prose
              id="instruction"
              rows={8}
              value={draft.instruction}
              onChange={(e) => change({ instruction: e.target.value })}
              {...inputState("instruction")}
              className="resize-y text-base sm:text-sm"
            />
            <p className="m-0 text-right text-xs text-dashboard-text-muted">
              {draft.instruction.length.toLocaleString()} / 4,000
            </p>
          </Field>
        </AutomationFormSection>
        <AutomationFormSection
          title="When to run"
          detail={
            original.kind === "scheduled"
              ? "Choose a schedule in a specific timezone."
              : "Run when a matching event occurs."
          }
        >
          <div
            id={`${triggerField}-error`}
            tabIndex={-1}
            aria-invalid={Boolean(triggerError) || undefined}
            className="grid min-w-0 gap-5 outline-none"
          >
            {triggerError ? (
              <p role="alert" className="m-0 text-sm text-rose-300">
                {triggerError}
              </p>
            ) : null}
            {original.kind === "scheduled" ? (
              <AutomationScheduleFields
                automation={original}
                value={draft.schedule}
                onChange={(schedule) => change({ schedule })}
              />
            ) : (
              <AutomationEventFields
                value={draft.trigger ?? original.trigger}
                original={original.trigger}
                onChange={(trigger) => change({ trigger })}
              />
            )}
          </div>
        </AutomationFormSection>
        <AutomationFormSection
          title="Where results go"
          detail="Choose who gets a message after successful work."
        >
          {fieldError("outcomes") ? (
            <p role="alert" className="m-0 text-sm text-rose-300">
              {fieldError("outcomes")}
            </p>
          ) : null}
          {owned ? (
            <AutomationOutcomeFields
              value={draft.outcomes}
              original={original.outcomes}
              destination={props.summary.destination}
              onChange={(outcomes) => change({ outcomes })}
            />
          ) : (
            <>
              <AutomationOutcomeList
                outcomes={original.outcomes}
                destination={props.summary.destination}
              />
              <p className="m-0 text-xs text-dashboard-text-muted">
                Only {creator} can change where results go.
              </p>
            </>
          )}
        </AutomationFormSection>
        <AutomationFormSection
          title="Credentials"
          detail="Choose which connected accounts Junior can use."
        >
          <fieldset className="divide-y divide-dashboard-border-subtle rounded-md border border-dashboard-border-emphasis">
            <legend className="sr-only">Credential mode</legend>
            {(
              [
                [
                  "creator",
                  owned
                    ? "Your connected accounts"
                    : `${creator}’s connected accounts`,
                  owned
                    ? "Uses accounts connected by you, the creator."
                    : `Uses accounts connected by ${creator}. Only ${creator} can turn this on.`,
                ],
                [
                  "system",
                  "System credentials only",
                  owned
                    ? "Does not use your connected accounts. Some work may not be possible."
                    : "Does not use anyone’s connected accounts. Some work may not be possible.",
                ],
              ] as const
            ).map(([value, label, detail]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-3 px-4 py-4 has-checked:bg-dashboard-fill-soft has-disabled:cursor-not-allowed has-disabled:opacity-60"
              >
                <input
                  type="radio"
                  name="credentials"
                  className="mt-0.5 size-4 shrink-0 accent-dashboard-focus"
                  checked={
                    dropsCreatorCredentials
                      ? value === "system"
                      : draft.credentialMode === value
                  }
                  disabled={
                    value === "creator" &&
                    !owned &&
                    (original.credentialMode !== "creator" ||
                      dropsCreatorCredentials)
                  }
                  onChange={() => change({ credentialMode: value })}
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-dashboard-text-muted">
                    {detail}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {dropsCreatorCredentials ? (
            <FormNotice title="Saving switches this automation to system credentials.">
              Only {creator} can let a changed instruction
              {original.kind === "event" ? " or trigger" : ""} use their
              connected accounts.
            </FormNotice>
          ) : null}
          {fieldError("credentialMode") ? (
            <p role="alert">{fieldError("credentialMode")}</p>
          ) : null}
        </AutomationFormSection>
        <AutomationVisibilityFields
          value={draft.visibility}
          destination={props.summary.destination}
          owned={owned}
          creator={creator}
          error={fieldError("visibility")}
          onChange={(visibility) => change({ visibility })}
        />
      </fieldset>
      <p className="mb-5 text-xs leading-relaxed text-dashboard-text-muted sm:hidden">
        Changes apply to future work. Saving does not run this automation.
      </p>
      <div className="sticky bottom-0 z-20 -mx-4 border-t border-dashboard-border-emphasis bg-dashboard-bg px-4 py-4 sm:-mx-8 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1" role="status">
            <p className="m-0 text-xs font-medium sm:text-sm">
              {save.isPending
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : "Unchanged"}
            </p>
            <p className="mt-1 mb-0 hidden text-xs text-dashboard-text-muted sm:block">
              Changes apply to future work. Saving does not run it.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to={props.returnPath}
              className="inline-flex min-h-11 items-center rounded border border-dashboard-border-emphasis px-3 text-sm text-dashboard-text no-underline sm:min-h-9"
            >
              Cancel
            </Link>
            <Button
              type="submit"
              tone="primary"
              className="min-h-11 sm:min-h-9"
              disabled={!dirty || save.isPending || conflict}
            >
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function formatEditValue(value: unknown): string {
  if (value == null) return "Not set";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
