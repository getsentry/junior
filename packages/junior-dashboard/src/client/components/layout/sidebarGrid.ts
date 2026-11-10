/**
 * The sidebar row grid for the header, destinations, conversations, and the
 * profile. Rows sit in the pane's 12px padding, so the 16px icon column starts
 * 24px from the pane edge and labels start 52px in, after a 12px gap.
 * Trailing content ends 24px from the other edge. Section labels and thread
 * rows keep the same `1rem` column and `gap-x-3`, and content outside the
 * grid, such as a waiting chip, indents `2.5rem` to reach the label edge.
 */
export const SIDEBAR_ROW_GRID_CLASS =
  "grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3 px-3";
