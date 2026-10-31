import {
  Brain,
  Braces,
  ChevronRight,
  Layers,
  SlidersHorizontal,
} from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { DetailsPanel } from "../components/DetailsPanel";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { Drawer } from "../components/Drawer";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import type { TranscriptViewTurnContext } from "../types";
import { formatMessageTimestamp, formatTime } from "../format";
import {
  memoryRecallContent,
  userCustomizationContent,
  type MemoryRecallContent,
} from "./turnContext";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { HighlightText } from "./transcriptSearch";
import { TranscriptSummaryTrigger } from "./TranscriptSummary";

/** The turn context that a page panel shows, keyed by its message. */
export type TurnContextSelection = {
  contexts: TranscriptViewTurnContext[];
  id: string;
};

/** Let the page that owns a panel show turn context there. */
export type TurnContextPanel = {
  openId?: string;
  onToggle(selection: TurnContextSelection): void;
};

const TurnContextPanelContext = createContext<TurnContextPanel | undefined>(
  undefined,
);

/**
 * Route turn context in one transcript to its owner's panel. Without a
 * `panel`, turn context opens in a modal drawer. Each transcript sets this, so
 * a nested transcript does not use the panel of the page behind it.
 */
export function TurnContextPanelProvider(props: {
  children: ReactNode;
  panel?: TurnContextPanel;
}) {
  return (
    <TurnContextPanelContext value={props.panel}>
      {props.children}
    </TurnContextPanelContext>
  );
}

/**
 * Show structured context attached to one transcript user message. The panel
 * keys context by `messageId`, so every control for one message, including a
 * remounted one, shows the same open state.
 */
export function TranscriptTurnContextView(props: {
  contexts: TranscriptViewTurnContext[];
  messageId?: string;
}) {
  const panel = useContext(TurnContextPanelContext);
  const [open, setOpen] = useState(false);
  const instanceId = useId();
  const id = props.messageId ?? instanceId;
  const expanded = panel ? panel.openId === id : open;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          // The open panel keeps focus here. Close the tooltip on click so
          // Escape reaches the panel.
          closeOnClick
          render={
            <Button
              aria-haspopup={panel ? undefined : "dialog"}
              aria-expanded={expanded}
              aria-label="View turn context"
              className={cn(
                "size-6 shrink-0",
                expanded && "bg-dashboard-fill-strong text-dashboard-text",
              )}
              data-turn-context-id={id}
              onClick={() => {
                if (!panel) return setOpen(true);
                panel.onToggle({ contexts: props.contexts, id });
              }}
              size="icon"
            >
              <Layers aria-hidden="true" size={14} strokeWidth={1.8} />
            </Button>
          }
        />
        <TooltipContent size="compact">View turn context</TooltipContent>
      </Tooltip>

      {!panel && open
        ? createPortal(
            <Drawer
              closeLabel="Close turn context"
              header={
                <h2
                  className="m-0 text-sm font-semibold text-dashboard-text"
                  id={instanceId}
                >
                  Turn context
                </h2>
              }
              onClose={() => setOpen(false)}
              openKey={instanceId}
              titleId={instanceId}
            >
              <TurnContextList contexts={props.contexts} />
            </Drawer>,
            document.body,
          )
        : null}
    </>
  );
}

/** Show turn context in the page panel: an aside, or a sheet on small screens. */
export function TurnContextDetails(props: {
  contexts: TranscriptViewTurnContext[];
  onClose(): void;
}) {
  return (
    <DetailsPanel
      label="Turn context"
      onClose={props.onClose}
      title={
        <h2 className="m-0 text-base font-semibold text-dashboard-text">
          Turn context
        </h2>
      }
    >
      <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <TurnContextList contexts={props.contexts} />
      </div>
    </DetailsPanel>
  );
}

// The current actor's customization comes first, above plugin context.
function TurnContextList(props: { contexts: TranscriptViewTurnContext[] }) {
  const contexts = [...props.contexts].sort(
    (a, b) =>
      Number(Boolean(userCustomizationContent(b))) -
      Number(Boolean(userCustomizationContent(a))),
  );
  return contexts.map((context, index) => (
    <TurnContext
      context={context}
      key={`${context.pluginName}:${context.kind}:${context.version}:${index}`}
    />
  ));
}

function TurnContext(props: { context: TranscriptViewTurnContext }) {
  const memory = memoryRecallContent(props.context);
  const customization = memory
    ? undefined
    : userCustomizationContent(props.context);
  const Icon = memory ? Brain : customization ? SlidersHorizontal : Braces;
  const title = memory
    ? "Recalled memories"
    : customization
      ? "User customization"
      : props.context.pluginName;

  return (
    <section className="border-b border-dashboard-border-strong py-5 last:border-b-0">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon
            aria-hidden="true"
            className="shrink-0 text-dashboard-accent-text/60"
            size={15}
          />
          <h3 className="m-0 truncate text-sm font-semibold text-dashboard-text">
            {title}
          </h3>
        </div>
        <span className="shrink-0 text-xs text-dashboard-text-muted">
          {props.context.kind} · v{props.context.version}
        </span>
      </div>

      {memory ? (
        <MemoryRecall
          loadedAt={props.context.loadedAt}
          memories={memory.memories}
        />
      ) : customization ? (
        <UserCustomization text={customization.text} />
      ) : (
        <GenericContext context={props.context} />
      )}
    </section>
  );
}

function UserCustomization(props: { text: string }) {
  return (
    <div className="whitespace-pre-wrap rounded-lg border border-dashboard-border-strong px-3 py-3 text-sm leading-6 text-dashboard-text">
      <HighlightText text={props.text} />
    </div>
  );
}

function MemoryRecall(props: {
  loadedAt: string;
  memories: MemoryRecallContent["memories"];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-dashboard-border-strong">
      {props.memories.map((memory, index) => (
        <Collapsible
          className="border-t border-dashboard-border-strong first:border-t-0"
          key={memory.id}
        >
          <TranscriptSummaryTrigger className="group flex items-start gap-2.5">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                dashboardDisclosureChevronClass,
                "mt-0.5 text-dashboard-text-muted",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-dashboard-text-muted">
                  Memory {index + 1}
                </span>
                <span className="shrink-0 text-xs text-dashboard-text-muted">
                  {memory.kind} · {memory.scope}
                </span>
              </span>
              <span className="mt-1 block truncate text-sm text-dashboard-text-muted">
                <HighlightText text={memory.content} />
              </span>
            </span>
          </TranscriptSummaryTrigger>

          <CollapsibleContent hiddenUntilFound>
            <div className="border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-4">
              <div className="whitespace-pre-wrap text-sm leading-6 text-dashboard-text">
                <HighlightText text={memory.content} />
              </div>

              <dl className="mt-4 grid gap-2 text-xs">
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                  <dt className="text-dashboard-text-muted">Memory ID</dt>
                  <dd className="m-0 break-all font-mono text-dashboard-text-muted">
                    <HighlightText text={memory.id} />
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                  <dt className="text-dashboard-text-muted">Observed</dt>
                  <dd className="m-0 text-dashboard-text-muted">
                    {formatTime(new Date(memory.observedAtMs).toISOString())}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                  <dt className="text-dashboard-text-muted">Scope</dt>
                  <dd className="m-0 text-dashboard-text-muted">
                    {memory.scope}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                  <dt className="text-dashboard-text-muted">Kind</dt>
                  <dd className="m-0 text-dashboard-text-muted">
                    {memory.kind}
                  </dd>
                </div>
              </dl>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
      <p className="m-0 border-t border-dashboard-border-strong px-3 py-2 text-xs text-dashboard-text-muted">
        {props.memories.length}{" "}
        {props.memories.length === 1 ? "memory" : "memories"} · Loaded{" "}
        {formatMessageTimestamp(Date.parse(props.loadedAt))}
      </p>
    </div>
  );
}

function GenericContext(props: { context: TranscriptViewTurnContext }) {
  return (
    <div>
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-dashboard-fill-soft p-3 text-xs leading-relaxed text-dashboard-text-muted">
        <HighlightText text={JSON.stringify(props.context.content, null, 2)} />
      </pre>
      <p className="m-0 mt-3 text-xs text-dashboard-text-muted">
        Loaded {formatMessageTimestamp(Date.parse(props.context.loadedAt))}
      </p>
    </div>
  );
}
