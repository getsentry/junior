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

/** The sheet that a sheet stacks on. */
export type ParentSheet = {
  /** Shut this sheet and each sheet that it stacks on. */
  closeAll(): void;
};

const ParentSheetContext = createContext<ParentSheet | undefined>(undefined);

/** Gives sheets that open from a sheet's body the sheet that they stack on. */
export const ParentSheetProvider = ParentSheetContext.Provider;

/** The sheet that this renders in, if any. */
export function useParentSheet(): ParentSheet | undefined {
  return useContext(ParentSheetContext);
}
