import { useState, useSyncExternalStore } from "react";

// The mobile/desktop layout split. `tailwind.css` repeats these queries in
// the `md` and `max-md` variants, so change both together.
//
// Width alone puts landscape phones (844-956px wide, under 480px tall) in
// the desktop shell. Short windows stay mobile below 64rem; wider windows are
// desktop at any height, so a tablet keyboard (`resizes-content`) cannot flip
// the layout mid-typing.

/** Matches viewports that get the desktop shell. */
export const DESKTOP_LAYOUT_QUERY =
  "(width >= 48rem) and ((width >= 64rem) or (height >= 30rem))";

/** Matches viewports that get the mobile shell. */
export const MOBILE_LAYOUT_QUERY =
  "(width < 48rem) or ((width < 64rem) and (height < 30rem))";

function subscribeToMobileLayout(onChange: () => void) {
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * Whether the viewport gets the mobile shell now. A phone has no room for
 * a detail that opens in place, so it opens in a `BottomSheet` there.
 */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    subscribeToMobileLayout,
    () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
    () => false,
  );
}

/**
 * Whether an overlay shows in its mobile form. An open overlay keeps the
 * form that it opened in, so a resize or a turn of the phone does not
 * remount it and lose its focus and its state.
 */
export function useMobileLayoutWhileOpen(open: boolean): boolean {
  const mobile = useMobileLayout();
  const [openedMobile, setOpenedMobile] = useState(mobile);
  if (!open && openedMobile !== mobile) setOpenedMobile(mobile);
  return open ? openedMobile : mobile;
}
