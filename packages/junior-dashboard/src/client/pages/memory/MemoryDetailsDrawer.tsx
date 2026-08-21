import { BrainCircuit } from "lucide-react";

import { Detail, DetailList } from "../../components/DetailList";
import { Drawer } from "../../components/Drawer";
import { TranscriptText } from "../../conversations/TranscriptText";
import type { PluginUserPageRecord } from "../user/pluginUserPageData";

/** Show one memory's content and metadata in a right-side slide-out. */
export function MemoryDetailsDrawer(props: {
  onClose(): void;
  record: PluginUserPageRecord | undefined;
}) {
  if (!props.record) return null;

  const { record } = props;
  const kind = metadataValue(record, "Type");
  const learned = metadataValue(record, "Learned");
  const remembered = metadataValue(record, "Remembered");
  const source = metadataValue(record, "Source");
  const story =
    learned === "Automatic"
      ? `Junior learned this from a ${source} conversation on ${shortDate(remembered)}.`
      : learned === "Explicit"
        ? `Someone asked Junior to remember this on ${shortDate(remembered)}.`
        : `Junior recorded this on ${shortDate(remembered)}.`;
  const scopeCopy = `It is stored as workspace ${kind.toLowerCase()} for future channels.`;
  const visibleMetadata = (record.metadata ?? []).filter(
    (item) => !["Learned", "Source", "Memory ID"].includes(item.label),
  );
  const titleId = "memory-details-drawer-title";

  return (
    <Drawer
      closeLabel="Close memory details"
      dismissLabel="Dismiss memory details"
      header={
        <>
          <h2
            className="m-0 font-display text-lg font-medium tracking-normal text-dashboard-text"
            id={titleId}
          >
            What Junior remembers
          </h2>
          <div className="mt-1 break-words font-mono text-xs leading-snug text-dashboard-text-muted">
            {kind} · {shortDate(remembered)}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={record.id}
      titleId={titleId}
    >
      <section className="grid gap-5">
        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
            Memory
          </div>
          <TranscriptText text={record.title} />
          {record.description ? (
            <div className="mt-3">
              <TranscriptText text={record.description} />
            </div>
          ) : null}
        </div>

        <div className="flex items-start gap-3 rounded border border-cyan-300/12 bg-cyan-300/[0.035] p-3">
          <BrainCircuit
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-cyan-200/70"
            size={15}
          />
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.12em] text-cyan-200/65">
              Why Junior remembers this
            </div>
            <div className="mt-1 font-mono text-xs leading-relaxed text-dashboard-text">
              {story} {scopeCopy}
            </div>
          </div>
        </div>

        {visibleMetadata.length ? (
          <DetailList>
            {visibleMetadata.map((item) => (
              <Detail
                key={item.label}
                label={item.label}
                valueClassName="font-mono"
              >
                {item.value}
              </Detail>
            ))}
          </DetailList>
        ) : null}
      </section>
    </Drawer>
  );
}

function metadataValue(record: PluginUserPageRecord, label: string): string {
  return record.metadata?.find((item) => item.label === label)?.value ?? "—";
}

function shortDate(value: string): string {
  return value.split(",").slice(0, 2).join(",");
}
