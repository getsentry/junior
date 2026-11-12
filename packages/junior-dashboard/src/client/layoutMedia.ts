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
