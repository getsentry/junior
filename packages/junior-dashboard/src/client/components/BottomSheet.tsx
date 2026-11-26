import { lazy, Suspense, useState, type ReactNode } from "react";

// A sheet opens only after a tap, so base-ui's drawer loads with the first
// open instead of with the page.
const BottomSheetContent = lazy(() =>
  import("./BottomSheetContent").then((module) => ({
    default: module.BottomSheetContent,
  })),
);

/** Props of a bottom sheet. */
export type BottomSheetProps = {
  /** Classes for the scrolling body, such as its padding. */
  bodyClassName?: string;
  children: ReactNode;
  label: string;
  /**
   * False shuts the sheet with its motion, as when the item in it closes.
   * `onClose` runs once it is shut.
   */
  open?: boolean;
  /** Runs once the sheet is shut, however it shut. */
  onClose(): void;
  /** `full`, the default, is a fixed tall sheet; `content` fits its content. */
  size?: "full" | "content";
  /**
   * Mount the sheet's layer where the sheet renders, not at the page's end.
   * A sheet that mounts by itself, as on a resize, then stays behind a
   * sheet or drawer that is already open.
   */
  stayBehind?: boolean;
  /** The visible title. Defaults to `label`. */
  title?: ReactNode;
};

/**
 * The phone sheet. It rises from the bottom edge over the page, with a
 * visible title, a close button, and a body that scrolls by itself. A swipe
 * down, a tap on the dimmed page, Esc, or the close button shuts it, and
 * nothing else does, so a tap inside it never loses it. Mount it to open
 * it. A sheet opened from inside another sheet stacks in front of it.
 */
export function BottomSheet(props: BottomSheetProps) {
  return (
    <Suspense fallback={null}>
      <BottomSheetContent {...props} />
    </Suspense>
  );
}

/**
 * A `BottomSheet` for an open state that its owner keeps, such as a list's
 * open row on a phone. It shows while `open`, and through its motion once
 * `open` turns false. `onDismiss` runs when the reader shuts it while it is
 * still open, so the owner can close its state.
 */
export function ToggleSheet(
  props: Omit<BottomSheetProps, "onClose" | "open"> & {
    onDismiss(): void;
    open: boolean;
  },
) {
  const { onDismiss, open, ...sheet } = props;
  const [shown, setShown] = useState(false);
  if (open && !shown) setShown(true);
  if (!shown) return null;
  return (
    <BottomSheet
      {...sheet}
      onClose={() => {
        setShown(false);
        if (open) onDismiss();
      }}
      open={open}
    />
  );
}
