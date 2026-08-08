import type { UseMutationResult } from "@tanstack/react-query";
import { BrainCircuit, Globe2, Trash2, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "../../components/Button";
import { TranscriptText } from "../../conversations/TranscriptText";
import type {
  PluginUserPageRecord,
  PluginUserPageRecordAction,
} from "../user/pluginUserPageData";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type MemoryActionMutation = UseMutationResult<
  void,
  Error,
  PluginUserPageRecordAction
>;

/** Show one memory's content and metadata in a right-side slide-out. */
export function MemoryDetailsDrawer(props: {
  action: MemoryActionMutation;
  onAction(action: PluginUserPageRecordAction): void;
  onClose(): void;
  record: PluginUserPageRecord | undefined;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const openRecordId = props.record?.id;
  onCloseRef.current = props.onClose;

  useEffect(() => {
    // Forget leaves the shared mutation in success/error until the next open.
    // Clear it here so the new drawer does not inherit stale action UI state.
    if (openRecordId) props.action.reset();
    // oxlint-disable-next-line react/exhaustive-deps -- reset only on open id change
  }, [openRecordId]);

  useEffect(() => {
    if (!openRecordId) return undefined;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-memory-drawer-close]")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!dialog || !first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = undefined;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [openRecordId]);

  if (!props.record) return null;

  const { record } = props;
  const kind = metadataValue(record, "Type");
  const learned = metadataValue(record, "Learned");
  const remembered = metadataValue(record, "Remembered");
  const source = metadataValue(record, "Source");
  const visibility = metadataValue(record, "Visibility");
  const isPublic = visibility === "Public";
  const story =
    learned === "Automatic"
      ? `Junior learned this from a ${source} conversation on ${shortDate(remembered)}.`
      : learned === "Explicit"
        ? isPublic
          ? `Someone asked Junior to remember this on ${shortDate(remembered)}.`
          : `You asked Junior to remember this on ${shortDate(remembered)}.`
        : `Junior recorded this on ${shortDate(remembered)}.`;
  const scopeCopy = isPublic
    ? `It is stored as workspace ${kind.toLowerCase()} for future channels.`
    : `It is stored as a ${kind.toLowerCase()} for future conversations.`;
  const visibleMetadata = (record.metadata ?? []).filter(
    (item) => !["Learned", "Source", "Memory ID"].includes(item.label),
  );
  const forgetAction = record.actions?.find(
    (recordAction) => recordAction.tone === "danger",
  );
  const titleId = "memory-details-drawer-title";

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed inset-0 z-50"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label="Dismiss memory details"
        className="absolute inset-0 cursor-default bg-black/55"
        onClick={props.onClose}
        tabIndex={-1}
        type="button"
      />
      <aside className="absolute top-0 right-0 grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-[#070707] shadow-[-20px_0_60px_rgba(0,0,0,0.45)] md:w-[min(560px,94vw)] md:border-l md:border-white/12">
        <header className="relative border-b border-white/10 bg-dashboard-surface-raised px-4 py-3 md:px-5">
          <div className="min-w-0 pr-12">
            <h2
              className="m-0 font-display text-lg font-medium tracking-normal text-dashboard-text"
              id={titleId}
            >
              What Junior remembers
            </h2>
            <div className="mt-1 break-words font-mono text-xs leading-snug text-dashboard-text-muted">
              {kind} · {visibility} · {shortDate(remembered)}
            </div>
          </div>
          <div className="absolute top-3 right-4 md:right-5">
            <Button
              aria-label="Close memory details"
              data-memory-drawer-close
              onClick={props.onClose}
              size="icon"
              title="Close"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 md:px-5">
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
              <dl className="grid gap-px overflow-hidden rounded border border-white/[0.06] bg-white/[0.055]">
                {visibleMetadata.map((item) => (
                  <MemoryDetail key={item.label} label={item.label}>
                    {item.value}
                  </MemoryDetail>
                ))}
              </dl>
            ) : null}

            {forgetAction ? (
              <button
                className="inline-flex w-fit cursor-pointer items-center gap-2 rounded border border-rose-300/15 bg-rose-300/[0.035] px-3 py-2 font-mono text-xs uppercase tracking-[0.08em] text-rose-200/75 transition-colors hover:border-rose-300/30 hover:bg-rose-300/[0.07] hover:text-rose-100"
                disabled={props.action.isPending}
                onClick={() => {
                  if (
                    forgetAction.confirmation &&
                    !window.confirm(forgetAction.confirmation)
                  ) {
                    return;
                  }
                  // Leave the permalink before the mutation refreshes queries so
                  // a deleted memory is not refetched while the drawer is open.
                  props.onClose();
                  props.onAction({
                    ...forgetAction,
                    confirmation: undefined,
                  });
                }}
                type="button"
              >
                <Trash2 aria-hidden="true" size={13} />
                Forget this memory
              </button>
            ) : isPublic ? (
              <div className="inline-flex w-fit items-center gap-2 rounded border border-white/[0.08] px-3 py-2 font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
                <Globe2 aria-hidden="true" size={13} />
                View only · public memories can&apos;t be deleted
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

function MemoryDetail(props: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 bg-[#09090b] px-3 py-3">
      <dt className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd className="mt-1.5 ml-0 break-words font-mono text-sm leading-relaxed text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}

function metadataValue(record: PluginUserPageRecord, label: string): string {
  return record.metadata?.find((item) => item.label === label)?.value ?? "—";
}

function shortDate(value: string): string {
  return value.split(",").slice(0, 2).join(",");
}
