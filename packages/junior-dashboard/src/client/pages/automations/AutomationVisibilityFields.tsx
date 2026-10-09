import type {
  AutomationEdit,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import { AutomationFormSection } from "./AutomationFormSection";

/**
 * Choose who can find and edit the Automation. Only the creator can change
 * it. Run transcripts keep the Destination visibility either way.
 */
export function AutomationVisibilityFields(props: {
  value: AutomationEdit["visibility"];
  destination: AutomationSummary["destination"];
  owned: boolean;
  creator: string;
  error?: string;
  onChange: (value: AutomationEdit["visibility"]) => void;
}) {
  const channel = props.destination.visibility;
  const onlyCreator = props.owned ? "Only you" : `Only ${props.creator}`;
  const options = [
    [
      null,
      `Same as the channel (${channel})`,
      channel === "public"
        ? "Anyone in the workspace can find and edit it, because it posts to a public channel."
        : `${onlyCreator} can find it, because it posts to a private channel or DM.`,
    ],
    [
      "public",
      "Public",
      "Anyone in the workspace can find and edit it. Run transcripts stay visible only to people who can see the channel.",
    ],
    [
      "private",
      "Private",
      `${onlyCreator} can find and edit it, even when it posts to a public channel.`,
    ],
  ] as const;
  return (
    <AutomationFormSection
      title="Who can see it"
      detail="Choose who can find and edit this automation."
    >
      <fieldset
        id="visibility-error"
        tabIndex={-1}
        aria-invalid={Boolean(props.error) || undefined}
        className="divide-y divide-dashboard-border-subtle rounded-md border border-dashboard-border-emphasis outline-none"
      >
        <legend className="sr-only">Automation visibility</legend>
        {options.map(([value, label, detail]) => (
          <label
            key={value ?? "destination"}
            className="flex cursor-pointer items-start gap-3 px-4 py-4 has-checked:bg-dashboard-fill-soft has-disabled:cursor-not-allowed has-disabled:opacity-60"
          >
            <input
              type="radio"
              name="visibility"
              className="mt-0.5 size-4 shrink-0 accent-dashboard-focus"
              checked={props.value === value}
              disabled={!props.owned}
              onChange={() => props.onChange(value)}
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
      {props.owned ? null : (
        <p className="m-0 text-xs text-dashboard-text-muted">
          Only {props.creator} can change who can see it.
        </p>
      )}
      {props.error ? (
        <p role="alert" className="m-0 text-sm text-rose-300">
          {props.error}
        </p>
      ) : null}
    </AutomationFormSection>
  );
}
