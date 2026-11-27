// The look of a `BottomSheet` for overlays that keep their own primitive on
// a phone, such as a menu or a popover. Each class applies only in the
// mobile layout (`max-md`), so the desktop look does not change. Base UI
// places a positioner with inline styles, so these classes are important.

/**
 * Pins a menu or popover positioner to the bottom edge of a phone. With the
 * variables that `PhoneSheetBand` reports, it fills the band above a touch
 * keyboard instead, and the sheet sits at the band's bottom edge.
 */
export const PHONE_SHEET_POSITIONER_CLASS =
  "max-md:pointer-events-none max-md:fixed! max-md:inset-x-0! max-md:top-[var(--phone-sheet-top,auto)]! max-md:bottom-[var(--phone-sheet-bottom,0px)]! max-md:flex max-md:h-[var(--phone-sheet-height,auto)]! max-md:flex-col max-md:justify-end max-md:transform-none! max-md:translate-none!";

/**
 * The surface of a phone sheet: full width, a rounded top edge, a grabber,
 * and a bottom inset that clears the home indicator, or a plain inset above
 * a touch keyboard. Its shadow dims the
 * page, and the modal menu or popover blocks taps on it.
 */
export const PHONE_SHEET_POPUP_CLASS =
  "max-md:relative max-md:mx-auto max-md:w-full! max-md:max-w-2xl! max-md:min-w-0! max-md:pointer-events-auto max-md:max-h-[min(85dvh,var(--phone-sheet-height,85dvh))]! max-md:origin-bottom max-md:rounded-t-xl max-md:rounded-b-none max-md:border-0 max-md:border-t max-md:border-dashboard-border-strong max-md:bg-dashboard-bg-elevated max-md:px-3 max-md:pt-6 max-md:pb-[var(--phone-sheet-pb,max(0.75rem,env(safe-area-inset-bottom)))] max-md:shadow-[0_0_0_100vmax_var(--color-dashboard-overlay)] max-md:ring-0 max-md:before:absolute max-md:before:top-2 max-md:before:left-1/2 max-md:before:h-1 max-md:before:w-9 max-md:before:-translate-x-1/2 max-md:before:rounded-full max-md:before:bg-dashboard-border-strong max-md:data-open:zoom-in-100 max-md:data-closed:zoom-out-100 max-md:data-open:slide-in-from-bottom-8 max-md:data-closed:slide-out-to-bottom-8";

/** The rows of a menu on a phone, as the rows of an action sheet. */
export const PHONE_MENU_ITEM_CLASS =
  "max-md:min-h-12 max-md:rounded-none max-md:gap-3 max-md:px-4 max-md:text-base max-md:[&_svg:not([class*='size-'])]:size-5";

/** The card that holds a menu's rows on a phone. */
export const PHONE_MENU_GROUP_CLASS =
  "max-md:overflow-hidden max-md:rounded-xl max-md:border max-md:border-dashboard-border-subtle max-md:bg-dashboard-fill-faint max-md:[&>[role=separator]]:mx-0 max-md:[&>[role=separator]]:my-0";
