import type { ActorIdentity } from "@sentry/junior/api/schema";
import { Layers } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import { ActorAvatar } from "../components/ActorAvatar";
import { DetailsPanel } from "../components/DetailsPanel";
import { participantName } from "../components/ParticipantAvatarStack";
import { Button } from "../components/ui/button";
import { Drawer } from "../components/Drawer";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import type { TranscriptViewTurnContext } from "../types";
import { formatMessageTimestamp, memoryPath, peoplePath } from "../format";
import {
  memoryRecallContent,
  userCustomizationContent,
  type MemoryRecallContent,
} from "./turnContext";
import { cn } from "../styles";
import { DetailsCard } from "./DetailsList";
import { HighlightText } from "./transcriptSearch";

/** What one turn context view shows: who spoke, when, and the context. */
export type TurnContext = {
  actor?: ActorIdentity;
  contexts: TranscriptViewTurnContext[];
  timestamp?: number;
};

/** The turn context that a page panel shows, keyed by its message. */
export type TurnContextSelection = TurnContext & { id: string };

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
export function TranscriptTurnContextView(
  props: TurnContext & { messageId?: string },
) {
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
                panel.onToggle({
                  actor: props.actor,
                  contexts: props.contexts,
                  id,
                  timestamp: props.timestamp,
                });
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
              <TurnContextBody
                actor={props.actor}
                contexts={props.contexts}
                timestamp={props.timestamp}
              />
            </Drawer>,
            document.body,
          )
        : null}
    </>
  );
}

/** Show turn context in the page panel: an aside, or a sheet on small screens. */
export function TurnContextDetails(props: TurnContext & { onClose(): void }) {
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
      <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <TurnContextBody
          actor={props.actor}
          contexts={props.contexts}
          timestamp={props.timestamp}
        />
      </div>
    </DetailsPanel>
  );
}

/** Show who spoke, then their customization, then plugin context. */
function TurnContextBody(props: TurnContext) {
  const contexts = [...props.contexts].sort(
    (a, b) =>
      Number(Boolean(userCustomizationContent(b))) -
      Number(Boolean(userCustomizationContent(a))),
  );
  return (
    <div className="grid min-w-0 gap-3">
      {props.actor ? (
        <TurnContextActor actor={props.actor} timestamp={props.timestamp} />
      ) : null}
      {contexts.map((context, index) => (
        <TurnContextCard
          context={context}
          key={`${context.pluginName}:${context.kind}:${context.version}:${index}`}
        />
      ))}
    </div>
  );
}

function TurnContextActor(props: { actor: ActorIdentity; timestamp?: number }) {
  const name = participantName(props.actor);
  const email = props.actor.email?.trim();
  const handle = props.actor.slackUserName?.trim();
  const meta = [
    email && email !== name ? email : undefined,
    handle && handle !== name ? `@${handle}` : undefined,
  ].filter(Boolean);
  return (
    <section
      aria-label="Speaker"
      className="flex min-w-0 items-center gap-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3"
    >
      <ActorAvatar name={name} size="detail" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          {email ? (
            <Link
              className="min-w-0 truncate text-sm font-medium text-dashboard-text no-underline hover:underline"
              to={peoplePath(email)}
            >
              {name}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium text-dashboard-text">
              {name}
            </span>
          )}
          {props.timestamp !== undefined ? (
            <time
              className="shrink-0 text-xs tabular-nums text-dashboard-text-muted"
              dateTime={new Date(props.timestamp).toISOString()}
            >
              {formatMessageTimestamp(props.timestamp, true)}
            </time>
          ) : null}
        </div>
        {meta.length ? (
          <p
            className="m-0 mt-0.5 truncate text-xs text-dashboard-text-muted"
            title={props.actor.slackUserId}
          >
            {meta.join(" · ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TurnContextCard(props: { context: TranscriptViewTurnContext }) {
  const memory = memoryRecallContent(props.context);
  if (memory) {
    return (
      <DetailsCard count={memory.memories.length} title="Recalled memories">
        <MemoryRecall memories={memory.memories} />
      </DetailsCard>
    );
  }
  const customization = userCustomizationContent(props.context);
  if (customization) {
    return (
      <DetailsCard title="User customization">
        <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-dashboard-text">
          <HighlightText text={customization.text} />
        </p>
      </DetailsCard>
    );
  }
  return (
    <DetailsCard
      title={`${props.context.pluginName} · ${props.context.kind} v${props.context.version}`}
    >
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        <HighlightText text={JSON.stringify(props.context.content, null, 2)} />
      </pre>
    </DetailsCard>
  );
}

// Each row links to the memory's page, which shows its details.
function MemoryRecall(props: { memories: MemoryRecallContent["memories"] }) {
  return (
    <ul className="-mx-1.5 -mb-1.5 -mt-1 grid list-none gap-0.5 p-0">
      {props.memories.map((memory) => (
        <li key={memory.id}>
          <Link
            className="line-clamp-2 rounded-md px-1.5 py-1.5 text-sm leading-5 text-dashboard-text no-underline transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
            to={memoryPath(memory.id)}
          >
            <HighlightText text={memory.content} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
