import {
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

// A sheet opens only after a tap, so base-ui's drawer loads with the first
// open instead of with the page.
const loadContent = () => import("./BottomSheetContent");
const BottomSheetContent = lazy(() =>
  loadContent().then((module) => ({ default: module.BottomSheetContent })),
);
const ActionSheetContent = lazy(() =>
  loadContent().then((module) => ({ default: module.ActionSheetContent })),
);

/** Props of a bottom sheet. */
export type BottomSheetProps = {
  /** Buttons beside the close button, such as a view toggle. */
  actions?: ReactNode;
  /**
   * Show ← before the title. The sheet shows a view one step deeper, and
   * `onBack` goes back one step. The close button still shuts the sheet.
   */
  back?: { label: string; onBack(): void } | undefined;
  /** Classes for the scrolling body, such as its padding. */
  bodyClassName?: string;
  children: ReactNode;
  /** The close button's accessible name. Defaults to "Close". */
  closeLabel?: string;
  /** Names the sheet. With `titleId`, the title names it instead. */
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
  /** Content under the title row, at the full width of the sheet. */
  subheader?: ReactNode;
  /** The visible title. Defaults to `label`. */
  title?: ReactNode;
  /**
   * The id of a heading in `title`. Set it when `title` has its own
   * heading, so the sheet does not wrap that heading in another one.
   */
  titleId?: string | undefined;
};

/**
 * The phone sheet. It rises from the bottom edge over the page, with a
 * visible title, a close button, and a body that scrolls by itself. Only a
 * swipe down, a tap on the dimmed page, Esc, or the close button shuts it.
 * Mount it to open it. A sheet opened from inside another sheet stacks in
 * front of it, shows ← to go back to it, and its close button shuts both.
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
 * `open` turns false. `onDismiss` runs when the reader shuts it while still
 * open. When `open` turns true again during the motion, as when a failed
 * action restores its row, a new sheet opens once the old one is shut.
 */
export function ToggleSheet(
  props: Omit<BottomSheetProps, "onClose" | "open"> & {
    onDismiss(): void;
    open: boolean;
  },
) {
  const { onDismiss, open, ...sheet } = props;
  const [shown, setShown] = useState(false);
  // Each opening gets its own sheet, since a shutting sheet cannot reopen.
  const [opening, setOpening] = useState(0);
  // Whether the owner shut this sheet, not the reader.
  const [ownerShut, setOwnerShut] = useState(false);
  if (open && !shown) {
    setShown(true);
    setOpening(opening + 1);
  }
  if (!open && shown && !ownerShut) setOwnerShut(true);
  if (!shown) return null;
  return (
    <BottomSheet
      {...sheet}
      key={opening}
      onClose={() => {
        setShown(false);
        setOwnerShut(false);
        if (!ownerShut) onDismiss();
      }}
      open={open && !ownerShut}
    />
  );
}

/** One row of an action sheet. Menus that have a phone form list these. */
export type ActionSheetItem = {
  disabled?: boolean | undefined;
  /** Status text for assistive technology, such as a share result. */
  feedback?: string | undefined;
  /** Opens in a new tab. */
  href?: string | undefined;
  icon: ComponentType<{ "aria-hidden"?: "true"; className?: string }>;
  key: string;
  label: string;
  onClick?(): void;
  /** Only the label shows the result, so the sheet stays open. */
  stayOpen?: boolean | undefined;
};

/** Props of an action sheet. */
export type ActionSheetProps = {
  /** Row groups. Each group is a card. */
  groups: readonly (readonly ActionSheetItem[])[];
  /**
   * Runs once the sheet is shut. It gets the chosen row's action, so the
   * owner can run it after focus goes back, as `useMenuSheet` does.
   */
  onClose(action?: () => void): void;
  /** Names the sheet for assistive technology. It does not show. */
  title: string;
};

/**
 * The phone form of a menu: a `BottomSheet` with rows in cards, and a
 * Cancel row instead of a close button. A tap on a row shuts
 * the sheet and passes the row's action to `onClose`.
 */
export function ActionSheet(props: ActionSheetProps) {
  return (
    <Suspense fallback={null}>
      <ActionSheetContent {...props} />
    </Suspense>
  );
}
