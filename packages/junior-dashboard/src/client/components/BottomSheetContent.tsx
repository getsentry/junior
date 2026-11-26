import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type CSSProperties } from "react";

import { useKeyboardBand } from "../mobileViewport";
import { cn } from "../styles";
import type { BottomSheetProps } from "./BottomSheet";
import { BottomSheetBodyProvider } from "./bottomSheetContext";
import { Button } from "./ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "./ui/drawer";
import { useSheet } from "./ui/useSheet";

/** Render the open bottom sheet. `BottomSheet` loads this module on demand. */
export function BottomSheetContent(props: BottomSheetProps) {
  const sheet = useSheet(props.onClose);
  const band = useKeyboardBand();
  const shut = props.open === false;
  const close = useEffectEvent(() => sheet.close());
  useEffect(() => {
    if (shut) close();
  }, [shut]);
  // While a touch keyboard is open, the sheet fills the band above it, as
  // the shell does, so the field in focus stays in view.
  const style: CSSProperties | undefined = band
    ? {
        bottom: "auto",
        height: `${band.heightPx}px`,
        maxHeight: `${band.heightPx}px`,
        top: `${band.offsetTopPx}px`,
      }
    : undefined;
  // The front modal is the last in the page, so a layer here stays behind
  // one that is already open.
  const layerRef = useRef<HTMLDivElement>(null);
  return (
    <Drawer {...sheet.rootProps}>
      {props.stayBehind ? <div className="contents" ref={layerRef} /> : null}
      <DrawerContent
        {...sheet.contentProps}
        container={props.stayBehind ? layerRef : undefined}
        aria-label={props.label}
        className={cn(
          "mx-auto w-full max-w-2xl bg-dashboard-bg-elevated",
          props.size !== "content" && "h-[85dvh]",
        )}
        data-dashboard-modal=""
        style={style}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-dashboard-border-strong"
        />
        <div className="flex shrink-0 items-start gap-2 border-b border-dashboard-border py-1.5 pr-2 pl-4">
          <DrawerTitle className="m-0 min-w-0 flex-1 break-words py-2 font-display text-base font-semibold leading-snug text-dashboard-text">
            {props.title ?? props.label}
          </DrawerTitle>
          <DrawerClose
            render={
              <Button
                aria-label="Close"
                className="pointer-coarse:size-11"
                size="icon"
                variant="ghost"
              />
            }
          >
            <XIcon aria-hidden="true" size={16} strokeWidth={2.25} />
          </DrawerClose>
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
          <BottomSheetBodyProvider value>
            {props.children}
          </BottomSheetBodyProvider>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
