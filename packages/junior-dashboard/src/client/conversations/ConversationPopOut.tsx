import { focusManager, useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, ExternalLink } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type { InputImage } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { ConversationSwitcher } from "../components/CommandPalette";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { DisplayText } from "../display-text/DisplayText";
import { conversationDetailTitle } from "../format";
import { DashboardApiError } from "../http";
import { isPlatformShortcut } from "../keyboard";
import { ConversationComposer } from "./ConversationComposer";
import { FOCUS_REPLY_STATE, conversationPath } from "./conversationRoutes";
import {
  conversationDetailQueryOptions,
  useAppendConversationMessage,
  useStopConversationTurn,
  type ConversationSnapshot,
} from "./queries";

// Chrome may make the window smaller to fit the screen.
const POP_OUT_SIZE = { height: 560, width: 380 };

// Document Picture-in-Picture: Chrome and Edge 116+. The DOM types do not
// have it yet.
type DocumentPictureInPicture = {
  requestWindow(options: { height: number; width: number }): Promise<Window>;
};

function documentPictureInPicture(): DocumentPictureInPicture | undefined {
  return (
    window as Window & { documentPictureInPicture?: DocumentPictureInPicture }
  ).documentPictureInPicture;
}

type PopOut = { conversationId: string; window: Window };

const OpenPopOutContext = createContext<
  ((conversationId: string) => Promise<void>) | undefined
>(undefined);

/**
 * Show a Conversation in the floating pop-out window. Undefined when the
 * browser cannot open one.
 */
export function useOpenConversationPopOut() {
  return useContext(OpenPopOutContext);
}

/**
 * Own the one pop-out window of this tab. It renders through a portal, so its
 * code runs here and shares this tab's queries.
 */
export function ConversationPopOutProvider(props: { children: ReactNode }) {
  const [popOut, setPopOut] = useState<PopOut>();
  const [supported] = useState(() => Boolean(documentPictureInPicture()));

  const open = useCallback(
    async (conversationId: string) => {
      if (popOut) {
        setPopOut({ ...popOut, conversationId });
        return;
      }
      const popOutWindow =
        await documentPictureInPicture()!.requestWindow(POP_OUT_SIZE);
      copyDashboardLook(popOutWindow.document);
      popOutWindow.addEventListener("pagehide", () => setPopOut(undefined), {
        once: true,
      });
      setPopOut({ conversationId, window: popOutWindow });
    },
    [popOut],
  );

  // React Query stops interval polls in a hidden tab. The reader watches the
  // pop-out while this tab is hidden, so report focus while it is open.
  // Chrome does not throttle the timers of a tab that has a pop-out.
  const popOutWindow = popOut?.window;
  useEffect(() => {
    if (!popOutWindow) return;
    focusManager.setFocused(true);
    return () => focusManager.setFocused(undefined);
  }, [popOutWindow]);

  return (
    <OpenPopOutContext value={supported ? open : undefined}>
      {props.children}
      {popOut
        ? createPortal(
            <PopOutView
              conversationId={popOut.conversationId}
              onConversationChange={(conversationId) =>
                setPopOut({ ...popOut, conversationId })
              }
              popOutWindow={popOut.window}
            />,
            popOut.window.document.body,
          )
        : null}
    </OpenPopOutContext>
  );
}

/**
 * Copy the dashboard styles and theme once. Later style changes in this tab
 * do not reach the pop-out.
 */
function copyDashboardLook(target: Document) {
  for (const node of document.head.querySelectorAll(
    'link[rel="stylesheet"], style',
  )) {
    target.head.append(node.cloneNode(true));
  }
  for (const { name, value } of document.documentElement.attributes) {
    target.documentElement.setAttribute(name, value);
  }
  target.body.className = document.body.className;
}

function PopOutView(props: {
  conversationId: string;
  onConversationChange(conversationId: string): void;
  popOutWindow: Window;
}) {
  const [switching, setSwitching] = useState(false);
  const navigate = useNavigate();
  const snapshot = useQuery(
    conversationDetailQueryOptions(props.conversationId),
  ).data;

  // Keys typed in the pop-out do not reach the dashboard window, so the
  // pop-out owns its ⌘K.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPlatformShortcut(event, "k") && !event.repeat) {
        event.preventDefault();
        setSwitching((open) => !open);
      } else if (event.key === "Escape" && switching) {
        event.preventDefault();
        setSwitching(false);
      }
    };
    const target = props.popOutWindow;
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [props.popOutWindow, switching]);

  const openInTab = () => {
    navigate(conversationPath(props.conversationId), {
      state: FOCUS_REPLY_STATE,
    });
    window.focus();
  };

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)_auto] bg-dashboard-bg font-sans text-dashboard-text">
      <header className="flex min-w-0 items-center gap-1 border-b border-dashboard-border-subtle px-2 py-1.5">
        <Button
          aria-expanded={switching}
          className="min-w-0 flex-1 justify-start"
          onClick={() => setSwitching((open) => !open)}
          variant="quiet"
        >
          <span className="min-w-0 truncate">
            {conversationDetailTitle(snapshot) ?? "Conversation"}
          </span>
          <ChevronsUpDown aria-hidden="true" className="shrink-0" size={14} />
        </Button>
        <Button aria-label="Open in tab" onClick={openInTab} size="icon">
          <ExternalLink aria-hidden="true" size={15} />
        </Button>
      </header>
      {switching ? (
        <ConversationSwitcher
          currentConversationId={props.conversationId}
          onSelect={(conversationId) => {
            props.onConversationChange(conversationId);
            setSwitching(false);
          }}
        />
      ) : (
        <PopOutReply snapshot={snapshot} />
      )}
      <PopOutComposer
        conversationId={props.conversationId}
        // A new Conversation needs a new draft and new send state.
        key={props.conversationId}
        working={snapshot?.status === "active"}
      />
    </div>
  );
}

/** The newest reply and whether a Turn runs. */
function PopOutReply(props: { snapshot: ConversationSnapshot | undefined }) {
  if (!props.snapshot) {
    return (
      <div
        aria-label="Loading reply"
        className="grid content-start gap-2 p-3"
        role="status"
      >
        <Skeleton aria-hidden="true" className="h-4 w-1/3" />
        <Skeleton aria-hidden="true" className="h-4 w-full" />
        <Skeleton aria-hidden="true" className="h-4 w-2/3" />
      </div>
    );
  }
  const reply = latestReplyText(props.snapshot);
  return (
    <main className="grid content-start gap-2 overflow-y-auto px-3 py-3">
      <span className="text-sm font-semibold text-dashboard-accent-text">
        {getDashboardAgentName()}
      </span>
      {reply ? (
        <DisplayText chat text={reply} />
      ) : (
        <p className="m-0 text-sm text-dashboard-text-muted">No reply yet.</p>
      )}
      {props.snapshot.status === "active" ? (
        <ShimmerText active className="text-sm text-dashboard-text-muted">
          Working…
        </ShimmerText>
      ) : null}
    </main>
  );
}

function latestReplyText(snapshot: ConversationSnapshot): string | undefined {
  return snapshot.events
    .flatMap(({ data }) =>
      data.type === "message" && data.role === "assistant" && data.text
        ? [data.text]
        : [],
    )
    .at(-1);
}

function PopOutComposer(props: { conversationId: string; working: boolean }) {
  const append = useAppendConversationMessage(props.conversationId);
  const stopTurn = useStopConversationTurn(props.conversationId);
  const send = async (
    message: string,
    idempotencyKey: string,
    images?: InputImage[],
  ) => {
    await append.mutateAsync({ idempotencyKey, images, message });
  };
  const stop = async () => {
    const result = await stopTurn.mutateAsync();
    const restored = result.stoppedMessages.map((message) => message.text);
    return restored.length ? restored.join("\n") : undefined;
  };
  return (
    <div className="px-2 pb-2">
      <ConversationComposer
        // Its own draft: the Conversation page in this tab keeps one too.
        draftId={`pop-out:${props.conversationId}`}
        error={
          append.error
            ? (append.error instanceof DashboardApiError &&
                append.error.apiError) ||
              "Could not send. Try again."
            : undefined
        }
        // No transcript shows the send, so the text stays until accepted.
        holdDraftUntilAccept
        label="Message"
        onStop={props.working ? stop : undefined}
        onSubmit={send}
        stopPending={stopTurn.isPending}
        submitLabel="Send"
      />
    </div>
  );
}
