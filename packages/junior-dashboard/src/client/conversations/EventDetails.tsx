import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptText } from "./TranscriptText";
import { eventLogModel } from "./eventLog";
import { formatCostBreakdown, summarizeCost } from "../format";

/** Present event content as readable sections, with the exact report available on demand. */
export function EventDetails({ event }: { event: ConversationReportEvent }) {
  const data = event.data;
  const model = eventLogModel(event);
  const usage = event.modelCall?.usage;
  const cost = summarizeCost(usage);
  let content: ReactNode;

  switch (data.type) {
    case "turn_routed": {
      const {
        type: _,
        modelId: _modelId,
        modelProfile: _profile,
        reasoningLevel: _reasoning,
        costUsd,
        ...metadata
      } = data;
      content = (
        <DetailSection title="Route selection">
          <DetailValue
            value={{
              ...metadata,
              ...(costUsd !== undefined
                ? { routerCostUsd: costUsd }
                : undefined),
            }}
          />
        </DetailSection>
      );
      break;
    }
    case "handoff": {
      const {
        type: _,
        modelId: _modelId,
        modelProfile: _profile,
        reasoningLevel: _reasoning,
        ...metadata
      } = data;
      content = (
        <DetailSection title="Handoff">
          <DetailValue value={metadata} />
        </DetailSection>
      );
      break;
    }
    case "message": {
      const { type: _, text, redacted, ...metadata } = data;
      content = (
        <>
          <DetailValue value={metadata} />
          <DetailSection title="Message">
            {redacted ? (
              <RedactedMarker />
            ) : (
              <TranscriptText text={text ?? ""} />
            )}
          </DetailSection>
        </>
      );
      break;
    }
    case "tool_calls":
      content = (
        <>
          {data.calls.map((call) => {
            const { name, input, output, ...metadata } = call;
            return (
              <DetailSection key={call.toolCallId} title={name}>
                <DetailValue value={metadata} />
                {input !== undefined ? (
                  <DetailSection title="Input">
                    <DetailValue value={input} />
                  </DetailSection>
                ) : null}
                {output !== undefined ? (
                  <DetailSection title="Output">
                    <DetailValue value={output} />
                  </DetailSection>
                ) : null}
              </DetailSection>
            );
          })}
          {data.assistant ? (
            <DetailSection title="Assistant">
              <DetailValue value={data.assistant} />
            </DetailSection>
          ) : null}
        </>
      );
      break;
    case "assistant_message":
      content = data.parts.map((part, index) => (
        <DetailSection key={index} title="Reasoning">
          {part.redacted ? (
            <RedactedMarker />
          ) : (
            <TranscriptText text={part.text ?? ""} />
          )}
        </DetailSection>
      ));
      break;
    case "structured_event": {
      const { type: _, presentation, ...metadata } = data;
      content = (
        <>
          <DetailValue value={metadata} />
          <DetailSection title={presentation.title}>
            {presentation.preview ? (
              <TranscriptText text={presentation.preview} />
            ) : null}
            {presentation.details?.map((detail, index) => (
              <DetailSection key={index} title={detail.title}>
                {detail.description ? (
                  <TranscriptText text={detail.description} />
                ) : null}
                {detail.content ? <DetailValue value={detail.content} /> : null}
                {detail.metadata ? (
                  <DetailValue value={detail.metadata} />
                ) : null}
              </DetailSection>
            ))}
          </DetailSection>
        </>
      );
      break;
    }
    default: {
      const { type: _, ...fields } = data;
      content = <DetailValue value={fields} />;
    }
  }

  return (
    <div className="grid min-w-0 gap-6">
      <section
        aria-label={
          data.type === "handoff" ? "Handoff target" : "Model at this event"
        }
        className="grid min-w-0 gap-3 rounded-md border border-dashboard-border bg-dashboard-surface-raised p-4"
      >
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          {data.type === "handoff" ? "Handoff target" : "Model at this event"}
        </h3>
        <p className="m-0 break-words font-mono text-base font-semibold text-violet-300 [overflow-wrap:anywhere]">
          {model?.modelId ?? "Model not recorded"}
        </p>
        {model ? (
          <DetailValue
            value={{
              modelProfile: model.modelProfile ?? "Not recorded",
              reasoningLevel: model.reasoningLevel ?? "Not recorded",
            }}
          />
        ) : null}
      </section>
      {event.modelCall ? (
        <DetailSection title="Model call">
          <DetailValue value={{ ...event.modelCall, usage: undefined }} />
          {usage ? (
            <>
              <DetailSection title="Tokens">
                <DetailValue
                  value={Object.fromEntries(
                    Object.entries(usage).filter(([key]) => key !== "cost"),
                  )}
                />
              </DetailSection>
              {cost ? (
                <DetailSection title="Estimated cost (USD)">
                  <DetailValue
                    value={Object.fromEntries(
                      Object.entries({ ...usage.cost, total: cost.total })
                        .filter(([, value]) => value !== undefined)
                        .map(([key, value]) => [
                          key,
                          formatCostBreakdown({ total: value! }),
                        ]),
                    )}
                  />
                </DetailSection>
              ) : null}
            </>
          ) : (
            <p className="m-0 text-sm text-dashboard-text-muted">
              Token usage and cost were not recorded for this call.
            </p>
          )}
          <p className="m-0 text-xs text-dashboard-text-muted">
            Usage is for this model call only, not the tool execution or
            conversation total. Input excludes cache reads and writes. Reasoning
            is part of output, not an extra token total.
          </p>
        </DetailSection>
      ) : null}
      {content}
      <details className="border-t border-dashboard-border pt-4">
        <summary className="cursor-pointer text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus">
          Raw JSON
        </summary>
        <pre className="mb-0 mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-dashboard-text">
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function DetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section aria-label={props.title} className="grid min-w-0 gap-3">
      <h3 className="m-0 break-words text-sm font-semibold text-dashboard-text">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return (words.charAt(0).toUpperCase() + words.slice(1))
    .replace(/\bid\b/gi, "ID")
    .replace(/\bids\b/gi, "IDs")
    .replace(/\busd\b/gi, "USD");
}

// Keep arbitrary tool and context payloads readable without guessing their schema.
function DetailValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return value.length ? (
      <ol className="m-0 grid min-w-0 list-decimal gap-4 pl-5 text-sm text-dashboard-text-muted">
        {value.map((item, index) => (
          <li key={index}>
            <DetailValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="text-sm text-dashboard-text-muted">Empty list</span>
    );
  }
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value).filter(
      ([, entry]) => entry !== undefined,
    );
    return fields.length ? (
      <dl className="m-0 grid min-w-0 gap-3">
        {fields.map(([key, entry]) => {
          const nested = typeof entry === "object" && entry !== null;
          return (
            <div
              key={key}
              className={
                nested
                  ? "grid min-w-0 gap-2"
                  : "grid min-w-0 grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3"
              }
            >
              <dt className="break-words text-sm text-dashboard-text-muted">
                {fieldLabel(key)}
              </dt>
              <dd className="m-0 min-w-0">
                <DetailValue value={entry} />
              </dd>
            </div>
          );
        })}
      </dl>
    ) : (
      <span className="text-sm text-dashboard-text-muted">Empty object</span>
    );
  }
  return (
    <span className="block whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-dashboard-text [overflow-wrap:anywhere]">
      {value === null ? "null" : value === "" ? "Empty text" : String(value)}
    </span>
  );
}
