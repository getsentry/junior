import { useEffect, useRef, useState, type ReactNode } from "react";

import { Modal } from "./Modal";

/** Show labeled content in a swipe-dismissable sheet with shared modal behavior. */
export function BottomSheet(props: {
  children: ReactNode;
  label: string;
  onClose(): void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const motionRef = useRef<Animation | null>(null);
  const closingRef = useRef(false);
  const dragStartRef = useRef<number | undefined>(undefined);
  const onCloseRef = useRef(props.onClose);
  const [offset, setOffset] = useState(0);
  onCloseRef.current = props.onClose;

  useEffect(
    () => () => {
      const motion = motionRef.current;
      motionRef.current = null;
      motion?.cancel();
    },
    [],
  );

  /** Animate from the current position and keep the last frame until cleanup. */
  const animateTo = (transform: string, onFinish?: () => void) => {
    const sheet = sheetRef.current;
    const from = sheet ? getComputedStyle(sheet).transform : "none";
    motionRef.current?.cancel();
    motionRef.current = null;
    setOffset(0);
    if (
      !sheet ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      onFinish?.();
      return;
    }
    const motion = sheet.animate(
      [
        { transform: from === "none" ? "translateY(0px)" : from },
        { transform },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "forwards",
      },
    );
    motionRef.current = motion;
    motion.onfinish = () => {
      if (motionRef.current === motion && sheet.isConnected) onFinish?.();
    };
  };
  /** Finish the exit before returning control to the owner. */
  const dismiss = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    dragStartRef.current = undefined;
    animateTo("translateY(100%)", () => onCloseRef.current());
  };

  return (
    <Modal
      dismissLabel={`Dismiss ${props.label}`}
      label={props.label}
      onClose={dismiss}
    >
      <aside
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 mx-auto grid h-[85dvh] max-h-full w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] rounded-t-2xl border border-b-0 border-dashboard-border-strong bg-dashboard-bg-elevated shadow-[-20px_0_60px_rgba(0,0,0,0.45)]"
        style={{ transform: `translateY(${offset}px)` }}
      >
        <div className="rounded-t-2xl bg-dashboard-bg-elevated px-4 pt-1 md:px-5">
          <div
            aria-hidden="true"
            data-drawer-handle=""
            className="flex touch-none cursor-grab justify-center py-3 active:cursor-grabbing"
            onPointerDown={(event) => {
              if (closingRef.current) return;
              const sheet = sheetRef.current;
              const transform = sheet
                ? getComputedStyle(sheet).transform
                : "none";
              const currentOffset =
                transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
              motionRef.current?.cancel();
              motionRef.current = null;
              setOffset(currentOffset);
              dragStartRef.current = event.clientY - currentOffset;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (dragStartRef.current !== undefined)
                setOffset(Math.max(0, event.clientY - dragStartRef.current));
            }}
            onPointerUp={(event) => {
              if (dragStartRef.current === undefined) return;
              const distance = Math.max(
                0,
                event.clientY - dragStartRef.current,
              );
              dragStartRef.current = undefined;
              if (distance >= 80) dismiss();
              else animateTo("translateY(0px)");
            }}
            onPointerCancel={() => {
              dragStartRef.current = undefined;
              if (!closingRef.current) animateTo("translateY(0px)");
            }}
          >
            <span className="h-1 w-9 rounded-full bg-dashboard-border-interactive" />
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {props.children}
        </div>
      </aside>
    </Modal>
  );
}
