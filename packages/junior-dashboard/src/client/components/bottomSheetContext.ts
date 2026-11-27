import { createContext, useContext } from "react";

const InBottomSheet = createContext(false);

/** Marks what renders in a `BottomSheet`'s scrolling body. */
export const BottomSheetBodyProvider = InBottomSheet.Provider;

/**
 * Whether this renders in a `BottomSheet`. A form there keeps its actions
 * on the sheet's bottom edge while its fields scroll.
 */
export function useInBottomSheet(): boolean {
  return useContext(InBottomSheet);
}
