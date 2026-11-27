import { ArrowLeft, XIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

import { keyboardBandStyle, useKeyboardBand } from "../mobileViewport";
import { cn } from "../styles";
import type {
  ActionSheetItem,
  ActionSheetProps,
  BottomSheetProps,
} from "./BottomSheet";
import {
  BottomSheetBodyProvider,
  ParentSheetProvider,
  useParentSheet,
} from "./bottomSheetContext";
import { Button } from "./ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "./ui/drawer";
import {
  ACTION_SHEET_GROUP_CLASS,
  ACTION_SHEET_ROW_CLASS,
} from "./ui/phoneSheet";
import { useSheet } from "./ui/useSheet";

/** Render the open bottom sheet. `BottomSheet` loads this module on demand. */
export function BottomSheetContent(props: BottomSheetProps) {
  const sheet = useSheet(props.onClose);
  const shutSheet = sheet.shut;
  const parent = useParentSheet();
  const shut = props.open === false;
  useEffect(() => {
    if (shut) shutSheet();
  }, [shutSheet, shut]);
  const stack = useMemo(
    () => ({
      closeAll() {
        shutSheet();
        parent?.closeAll();
      },
    }),
    [shutSheet, parent],
  );
  const band = useKeyboardBand();
  // A sheet on a sheet is one step deeper, so ← goes back to the one below.
  const back =
    props.back ?? (parent ? { label: "Back", onBack: shutSheet } : undefined);
  return (
    <SheetFrame
      // A title with its own heading names the sheet. Otherwise the label
      // does.
      name={
        props.titleId
          ? { "aria-labelledby": props.titleId }
          : { "aria-label": props.label }
      }
      className={cn(
        "max-w-2xl bg-dashboard-bg-elevated",
        props.size !== "content" && "h-[85dvh]",
      )}
      sheet={sheet}
      stayBehind={props.stayBehind}
      style={keyboardBandStyle(band)}
    >
      {/* Positioned so header overlays, such as transcript search,
              float over the body. */}
      <div className="relative z-10 shrink-0 border-b border-dashboard-border">
        <div
          className={cn(
            "flex items-start gap-2 py-1.5 pr-2",
            back ? "pl-1" : "pl-4",
          )}
        >
          {back ? (
            <Button
              aria-label={back.label}
              className="pointer-coarse:size-11"
              onClick={back.onBack}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
            </Button>
          ) : null}
          {props.titleId ? (
            <div className="min-w-0 flex-1 py-1">{props.title}</div>
          ) : (
            <DrawerTitle className="m-0 min-w-0 flex-1 break-words py-2 font-display text-base font-semibold leading-snug text-dashboard-text">
              {props.title ?? props.label}
            </DrawerTitle>
          )}
          {props.actions ? (
            <div className="flex shrink-0 items-center gap-1">
              {props.actions}
            </div>
          ) : null}
          <DrawerClose
            onClick={() => parent?.closeAll()}
            render={
              <Button
                aria-label={props.closeLabel ?? "Close"}
                className="pointer-coarse:size-11"
                size="icon"
                variant="ghost"
              />
            }
          >
            <XIcon aria-hidden="true" size={16} strokeWidth={2.25} />
          </DrawerClose>
        </div>
        {props.subheader ? (
          <div className="min-w-0 px-4 pb-2">{props.subheader}</div>
        ) : null}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
          // The last line clears the home indicator. With the keyboard
          // open, the keyboard covers it instead.
          !band && "pb-[env(safe-area-inset-bottom)]",
          props.bodyClassName,
        )}
      >
        <ParentSheetProvider value={stack}>
          <BottomSheetBodyProvider value>
            {props.children}
          </BottomSheetBodyProvider>
        </ParentSheetProvider>
      </div>
    </SheetFrame>
  );
}

// Rows sit in a group, which owns the border and the fill.
const PLAIN_ROW_CLASS = cn(ACTION_SHEET_ROW_CLASS, "border-0 bg-transparent");

/** Render the open action sheet. `ActionSheet` loads this module on demand. */
export function ActionSheetContent(props: ActionSheetProps) {
  // Focus the list, not its first row, so a touch open shows no focus ring.
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = useRef<(() => void) | undefined>(undefined);
  const sheet = useSheet(() => props.onClose(chosen.current), listRef);
  const choose = (action: (() => void) | undefined) => {
    chosen.current = action;
    sheet.close();
  };
  return (
    <SheetFrame
      className="max-w-lg pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      sheet={sheet}
    >
      <DrawerTitle className="m-0 truncate px-5 pt-3 pb-2 text-center font-sans text-sm font-medium text-dashboard-text-muted">
        {props.title}
      </DrawerTitle>
      <div
        className="grid min-h-0 gap-2 overflow-y-auto overscroll-contain px-3 outline-none"
        ref={listRef}
        tabIndex={-1}
      >
        {props.groups.map((items, index) => (
          <ul
            className={cn(
              ACTION_SHEET_GROUP_CLASS,
              "m-0 list-none divide-y divide-dashboard-border-subtle p-0",
            )}
            key={index}
          >
            {items.map((item) => (
              <li key={item.key}>
                <ActionSheetRow
                  item={item}
                  onChoose={choose}
                  onClose={sheet.close}
                />
              </li>
            ))}
          </ul>
        ))}
        <DrawerClose
          className={cn(
            ACTION_SHEET_ROW_CLASS,
            ACTION_SHEET_GROUP_CLASS,
            "justify-center font-medium",
          )}
        >
          Cancel
        </DrawerClose>
      </div>
    </SheetFrame>
  );
}

function ActionSheetRow(props: {
  item: ActionSheetItem;
  onChoose(action: (() => void) | undefined): void;
  onClose(): void;
}) {
  const { item } = props;
  const icon = <item.icon aria-hidden="true" />;
  if (item.href) {
    return (
      <a
        className={PLAIN_ROW_CLASS}
        href={item.href}
        onClick={props.onClose}
        rel="noreferrer"
        target="_blank"
      >
        {icon}
        {item.label}
      </a>
    );
  }
  return (
    <>
      <button
        className={PLAIN_ROW_CLASS}
        disabled={item.disabled}
        onClick={() => {
          // Share and copy show their result in the label, so they stay.
          if (item.stayOpen) item.onClick?.();
          else props.onChoose(item.onClick);
        }}
        type="button"
      >
        {icon}
        {item.label}
      </button>
      {item.feedback === undefined ? null : (
        <span className="sr-only" role="status">
          {item.feedback}
        </span>
      )}
    </>
  );
}

/**
 * The parts that every bottom sheet shares: the swipe drawer, the grabber,
 * the modal marker, and the layer for `stayBehind`.
 */
function SheetFrame(props: {
  children: ReactNode;
  className?: string;
  /** Without it, the sheet's `DrawerTitle` names it. */
  name?: { "aria-label": string } | { "aria-labelledby": string };
  sheet: ReturnType<typeof useSheet>;
  stayBehind?: boolean | undefined;
  style?: CSSProperties | undefined;
}) {
  // The front modal is the last in the page, so a layer here stays behind
  // one that is already open.
  const layerRef = useRef<HTMLDivElement>(null);
  return (
    <Drawer {...props.sheet.rootProps}>
      {props.stayBehind ? <div className="contents" ref={layerRef} /> : null}
      <DrawerContent
        {...props.sheet.contentProps}
        container={props.stayBehind ? layerRef : undefined}
        {...props.name}
        className={cn("mx-auto w-full", props.className)}
        data-dashboard-modal=""
        style={props.style}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-dashboard-border-strong"
        />
        {props.children}
      </DrawerContent>
    </Drawer>
  );
}
