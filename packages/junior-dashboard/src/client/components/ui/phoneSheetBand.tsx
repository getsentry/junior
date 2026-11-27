import { useEffect, type CSSProperties } from "react";
import { useKeyboardBand } from "@dashboard/keyboardBand";

// A phone popover loads this module on demand, so the keyboard band stays
// out of the first load.

/**
 * Report the CSS variables that place a phone sheet positioner in the band
 * above an open touch keyboard, or undefined while no keyboard is open.
 */
export function PhoneSheetBand(props: {
  onChange(style: CSSProperties | undefined): void;
}) {
  const band = useKeyboardBand();
  const { onChange } = props;
  useEffect(() => {
    if (!band) {
      onChange(undefined);
      return;
    }
    const vars: CSSProperties & Record<`--phone-sheet-${string}`, string> = {
      "--phone-sheet-bottom": "auto",
      // The keyboard covers the home indicator, so the sheet needs no
      // inset for it.
      "--phone-sheet-pb": "0.75rem",
      "--phone-sheet-height": `${band.heightPx}px`,
      "--phone-sheet-top": `${band.offsetTopPx}px`,
    };
    onChange(vars);
  }, [band, onChange]);
  return null;
}
