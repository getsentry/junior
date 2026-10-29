import { Globe2, Lock, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DetailsPanel } from "../../components/DetailsPanel";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { TranscriptText } from "../../conversations/TranscriptText";
import type {
  PluginUserPageRecord,
  PluginUserPageRecordAction,
} from "../user/pluginUserPageData";

// The memory plugin API does not resolve mentions yet, so memory text shows
// Slack ids instead of names.
const NO_MEMORY_MENTIONS: readonly [] = [];

// The heading, origin, and scope rows already show these values.
const SUMMARIZED_METADATA = new Set([
  "Learned",
  "Memory ID",
  "Source",
  "Type",
  "Visibility",
]);

/** Show one memory beside the library, or in a bottom sheet on small screens. */
export function MemoryDetails(props: {
  forgetPending: boolean;
  onClose(): void;
  onForget(action: PluginUserPageRecordAction): void;
  record: PluginUserPageRecord | undefined;
}) {
  const { record } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const heading = record ? memoryHeading(record) : "Memory details";
  const isPublic = record && metadataValue(record, "Visibility") === "Public";
  const VisibilityIcon = isPublic ? Globe2 : Lock;
  const forgetAction = record?.actions?.find(
    (recordAction) => recordAction.tone === "danger",
  );

  return (
    <DetailsPanel
      actions={
        forgetAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Forget this memory"
                  disabled={props.forgetPending}
                  onClick={() => {
                    if (forgetAction.confirmation) setConfirmOpen(true);
                    else props.onForget(forgetAction);
                  }}
                  size="icon"
                  variant="danger"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </Button>
              }
            />
            <TooltipContent size="compact">Forget this memory</TooltipContent>
          </Tooltip>
        ) : undefined
      }
      label="Memory details"
      onClose={props.onClose}
      sheetTitle={heading}
      title={
        <h2 className="m-0 flex items-center gap-2 font-display text-base font-medium text-dashboard-text">
          {record ? (
            <VisibilityIcon
              aria-hidden="true"
              className="shrink-0 text-dashboard-text-muted"
              size={14}
            />
          ) : null}
          <span className="truncate">{heading}</span>
        </h2>
      }
    >
      <div className="grid min-w-0 gap-4 p-4 [overflow-wrap:anywhere]">
        {record ? (
          <>
            <div className="grid gap-3 text-sm leading-relaxed">
              <TranscriptText
                mentions={NO_MEMORY_MENTIONS}
                text={record.title}
              />
              {record.description ? (
                <TranscriptText
                  mentions={NO_MEMORY_MENTIONS}
                  text={record.description}
                />
              ) : null}
            </div>
            <MemoryFacts record={record} />
          </>
        ) : (
          <PageContentSkeleton label="Loading memory" variant="panel" />
        )}
      </div>
      {forgetAction?.confirmation && record ? (
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>{forgetAction.confirmation}</AlertDialogTitle>
            <AlertDialogDescription>{record.title}</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmOpen(false);
                  props.onForget(forgetAction);
                }}
                variant="danger"
              >
                {forgetAction.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </DetailsPanel>
  );
}

function MemoryFacts(props: { record: PluginUserPageRecord }) {
  const { record } = props;
  const learned = metadataValue(record, "Learned");
  const source = metadataValue(record, "Source");
  const visibility = metadataValue(record, "Visibility");
  const isPublic = visibility === "Public";
  const origin =
    learned === "Automatic"
      ? `From a ${source ?? "past"} conversation`
      : learned === "Explicit"
        ? isPublic
          ? "Someone asked Junior"
          : "You asked Junior"
        : learned
          ? "Before origin tracking"
          : undefined;
  const remembered = metadataValue(record, "Remembered");
  // Most memories are saved when Junior sees them. Show one date in that case.
  const dates = (record.metadata ?? []).filter(
    (item) =>
      !SUMMARIZED_METADATA.has(item.label) &&
      !(item.label === "Observed" && item.value === remembered),
  );
  return (
    <dl className="m-0 grid gap-2 border-t border-dashboard-border-subtle pt-4 text-xs leading-relaxed">
      {origin ? <MemoryFact label="Learned">{origin}</MemoryFact> : null}
      {visibility ? (
        <MemoryFact label="Used in">
          {isPublic ? "Future workspace channels" : "Your future conversations"}
        </MemoryFact>
      ) : null}
      {dates.map((item) => (
        <MemoryFact key={item.label} label={item.label}>
          <span className="tabular-nums">{item.value}</span>
        </MemoryFact>
      ))}
    </dl>
  );
}

function MemoryFact(props: { children: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] gap-3">
      <dt className="text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 text-dashboard-text">{props.children}</dd>
    </div>
  );
}

/** Name a memory by visibility and type, such as "Private preference". */
function memoryHeading(record: PluginUserPageRecord): string {
  const kind = metadataValue(record, "Type");
  const visibility = metadataValue(record, "Visibility");
  if (!kind) return visibility ? `${visibility} memory` : "Memory";
  return visibility ? `${visibility} ${kind.toLowerCase()}` : kind;
}

function metadataValue(
  record: PluginUserPageRecord,
  label: string,
): string | undefined {
  return record.metadata?.find((item) => item.label === label)?.value;
}
