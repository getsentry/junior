import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptText } from "./TranscriptText";
import { eventLogModel } from "./eventLog";
import { formatCostBreakdown } from "../format";
import { EventUsage } from "./EventUsage";

/** Present event content as readable sections, with the exact report available on demand. */
export function EventDetails({ event }: { event: ConversationReportEvent }) {
  const data = event.data;
  const model = eventLogModel(event);
  const { usage, ...callAttributes } = event.modelCall ?? {};
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
                ? { routerCostUsd: formatCostBreakdown({ total: costUsd }) }
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
        summary,
        ...metadata
      } = data;
      content = (
        <>
          {Object.keys(metadata).length > 0 ? (
            <DetailValue value={metadata} />
          ) : null}
          {summary ? (
            <DetailSection title="Continuation summary">
              <TranscriptText text={summary} />
            </DetailSection>
          ) : null}
        </>
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
    <div className="@container grid min-w-0 gap-6">
      <DetailSection
        title={
          data.type === "handoff" ? "Target configuration" : "Configuration"
        }
      >
        <DetailValue
          value={{
            model: model?.modelId ?? "Not recorded",
            ...(model
              ? {
                  modelProfile: model.modelProfile ?? "Not recorded",
                  reasoningLevel: model.reasoningLevel ?? "Not recorded",
                }
              : undefined),
            ...callAttributes,
          }}
        />
      </DetailSection>
      {event.modelCall ? (
        <DetailSection title="Call usage">
          <EventUsage usage={usage} />
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
    <section aria-label={props.title} className="grid min-w-0 gap-2">
      <h3 className="m-0 border-b border-dashboard-border pb-2 text-sm font-semibold text-dashboard-text">
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
    .replace(/\busd\b/gi, "USD")
    .replace(/\bapi\b/gi, "API");
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
      <dl className="m-0 grid min-w-0 divide-y divide-dashboard-border-subtle">
        {fields.map(([key, entry]) => {
          const nested = typeof entry === "object" && entry !== null;
          return (
            <div
              key={key}
              className={
                nested
                  ? "grid min-w-0 gap-2 py-2"
                  : "grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-baseline gap-x-4 py-2 @min-[30rem]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]"
              }
            >
              <dt className="break-words text-xs leading-relaxed text-dashboard-text-muted">
                {fieldLabel(key)}
              </dt>
              <dd className="m-0 min-w-0">
                {nested ? (
                  <div className="border-l border-dashboard-border pl-3">
                    <DetailValue value={entry} />
                  </div>
                ) : (
                  <DetailValue value={entry} />
                )}
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
    <span className="block whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-dashboard-text [overflow-wrap:anywhere]">
      {value === null ? "null" : value === "" ? "Empty text" : String(value)}
    </span>
  );
}
