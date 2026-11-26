/**
 * Show a Lead's menu with its Space's archive. The menu's Archive acts on
 * the Space, and the Space actions write its state to the cache at once,
 * before the Lead's detail reads again.
 */
export function leadMenuState<C extends { archivedAt?: string | null }, D>(
  menu: { conversation: C | undefined; detail: D | undefined },
  space: { archivedAt?: string | null } | undefined,
): { conversation: C | undefined; detail: D | undefined } {
  if (!space || !menu.conversation) return menu;
  return {
    ...menu,
    conversation: { ...menu.conversation, archivedAt: space.archivedAt },
  };
}
