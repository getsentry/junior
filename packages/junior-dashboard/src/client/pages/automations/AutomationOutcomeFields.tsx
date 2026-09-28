import { ArrowUp, Trash2, Plus } from "lucide-react";
import type {
  AutomationEdit,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { cn } from "../../styles";
import type { AutomationDraft } from "./automationDraft";

type Outcome = AutomationDraft["outcomes"][number];

/** Describe a retained Destination without guessing a recipient from a private id. */
export function automationOutcomeLabel(
  outcome: Outcome,
  destination: AutomationSummary["destination"],
): string {
  if (typeof outcome.destination === "string")
    return outcome.destination === "task_creator"
      ? "You · Direct message"
      : `${destination.label} · ${destination.visibility}`;
  if (
    outcome.destination.channelId === destination.channelId &&
    outcome.destination.teamId === destination.teamId
  )
    return `${destination.label} · ${destination.visibility}`;
  return `Saved destination · ${outcome.destination.channelId}`;
}

/** Preserve ordered stored outcomes and allow only the two supported new targets. */
export function AutomationOutcomeFields(props: {
  value: AutomationDraft["outcomes"];
  original: AutomationEdit["outcomes"];
  destination: AutomationSummary["destination"];
  onChange(value: AutomationDraft["outcomes"]): void;
}) {
  return (
    <>
      <fieldset>
        <legend className="sr-only">Success messages</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {[true, false].map((send) => (
            <label
              key={String(send)}
              className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="messages"
                className="size-4 accent-dashboard-focus"
                checked={Boolean(props.value.length) === send}
                onChange={() =>
                  props.onChange(
                    send
                      ? props.original.length
                        ? props.original
                        : [
                            {
                              action: "send_message",
                              destination: "current_conversation",
                            },
                          ]
                      : [],
                  )
                }
              />
              {send ? "Send a message" : "No success message"}
            </label>
          ))}
        </div>
      </fieldset>
      {props.value.length ? (
        <div className="grid gap-4 sm:gap-2">
          {props.value.map((outcome, index) => {
            const retainedIndex = props.original.findIndex(
              (item) => JSON.stringify(item) === JSON.stringify(outcome),
            );
            return (
              <div
                key={index}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span className="w-4 text-xs text-dashboard-text-muted">
                  {index + 1}.
                </span>
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    props.value.length > 1 &&
                      "order-last basis-full sm:order-none sm:basis-auto",
                  )}
                >
                  <Select
                    aria-label={`Message ${index + 1} destination`}
                    value={
                      typeof outcome.destination === "string"
                        ? outcome.destination
                        : `saved:${retainedIndex}`
                    }
                    onChange={(e) =>
                      props.onChange(
                        props.value.map((item, i) =>
                          i !== index
                            ? item
                            : e.target.value.startsWith("saved:")
                              ? props.original[Number(e.target.value.slice(6))]
                              : {
                                  action: "send_message",
                                  destination: e.target.value as
                                    | "task_creator"
                                    | "current_conversation",
                                },
                        ),
                      )
                    }
                  >
                    {props.original.map((saved, i) => (
                      <option key={i} value={`saved:${i}`}>
                        {automationOutcomeLabel(saved, props.destination)}
                      </option>
                    ))}
                    <option value="current_conversation">
                      {props.destination.label} · {props.destination.visibility}
                    </option>
                    <option value="task_creator">You · Direct message</option>
                  </Select>
                </div>
                {props.value.length > 1 ? (
                  <>
                    <Button
                      size="icon"
                      className="ml-auto sm:ml-0"
                      aria-label={`Move message ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...props.value];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        props.onChange(next);
                      }}
                    >
                      <ArrowUp size={16} />
                    </Button>
                    <Button
                      size="icon"
                      aria-label={`Remove message ${index + 1}`}
                      onClick={() =>
                        props.onChange(
                          props.value.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  </>
                ) : null}
              </div>
            );
          })}
          {props.value.length < 5 ? (
            <Button
              className="w-fit"
              onClick={() =>
                props.onChange([
                  ...props.value,
                  { action: "send_message", destination: "task_creator" },
                ])
              }
            >
              <Plus size={15} />
              Add message
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
          Junior still does the work. No message is sent after success.
        </p>
      )}
      <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
        {props.value.length ? "Messages are sent in this order. " : ""}This does
        not limit actions in the instruction.
      </p>
    </>
  );
}
