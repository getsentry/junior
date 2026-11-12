import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useDetailsPanel } from "../components/DetailsPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import {
  DETAILS_WIDTH,
  readDetailsWidth,
  saveDetailsWidth,
} from "./conversationSidebarLayout";

const SIDE_PANEL_ID = "conversation-side-panel";
const TRANSCRIPT_MIN_WIDTH = "28rem";

/** Show the transcript with its open side panel in a resizable column. */
export function ConversationSidePanelLayout(props: {
  children: ReactNode;
  /** Details, event details, turn context, or a Quick question. */
  side?: ReactNode;
}) {
  const panelFits = useDetailsPanel();
  const groupRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const sheetSlotRef = useRef<HTMLDivElement>(null);
  // Below the panel width, side panels show as bottom sheets instead. The
  // side panel renders into one host node that moves between the column and
  // the sheet slot, so it keeps its state and focus at that width change.
  // A server render has no document, so it renders the side panel inline.
  const [host] = useState(() => {
    if (typeof document === "undefined") return undefined;
    const element = document.createElement("div");
    element.className = "grid min-h-0 min-w-0";
    return element;
  });
  const open = props.side !== undefined;
  const resizable = open && panelFits;
  useLayoutEffect(() => {
    const slot = resizable ? columnRef.current : sheetSlotRef.current;
    if (host && slot && host.parentNode !== slot) slot.append(host);
  }, [host, resizable]);

  return (
    <>
      <ResizablePanelGroup
        className="min-h-0 min-w-0"
        elementRef={groupRef}
        onLayoutChanged={(layout, meta) => {
          // Save only the reader's own resize, after it ends. Mount and
          // constraint passes can squeeze the panel below the chosen width.
          if (!meta.isUserInteraction) return;
          const percent = layout[SIDE_PANEL_ID] ?? 0;
          const groupWidth = groupRef.current?.offsetWidth ?? 0;
          if (percent > 0) saveDetailsWidth((percent / 100) * groupWidth);
        }}
      >
        {/* Keep the transcript mounted when the side panel opens or closes. */}
        <ResizablePanel
          className="grid min-h-0"
          id="conversation-transcript"
          minSize={TRANSCRIPT_MIN_WIDTH}
        >
          {props.children}
        </ResizablePanel>
        {resizable ? (
          <>
            <ResizableHandle
              aria-label="Resize details panel"
              className="w-px bg-transparent transition-colors after:w-2 focus-visible:ring-dashboard-border-interactive data-[separator=active]:bg-dashboard-border-interactive data-[separator=hover]:bg-dashboard-border-interactive"
            />
            <ResizablePanel
              className="grid min-h-0"
              defaultSize={readDetailsWidth()}
              groupResizeBehavior="preserve-pixel-size"
              id={SIDE_PANEL_ID}
              maxSize={`${DETAILS_WIDTH.max}rem`}
              minSize={`${DETAILS_WIDTH.min}rem`}
            >
              <div className="grid h-full min-h-0" ref={columnRef} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      <div className="contents" ref={sheetSlotRef} />
      {open ? (host ? createPortal(props.side, host) : props.side) : null}
    </>
  );
}
