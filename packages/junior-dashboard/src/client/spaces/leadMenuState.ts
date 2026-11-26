import type { SpaceReport } from "@sentry/junior/api/schema";

/**
 * Show a Lead's menu from its Space's archive and membership. The menu's
 * Archive, Join, and Leave act on the Space, and the Space actions write
 * its state to the cache at once, before the Lead's detail reads again.
 */
export function leadMenuState<
  C extends { archivedAt?: string | null },
  D extends { isParticipant?: boolean; subscribed?: boolean },
>(
  menu: { conversation: C | undefined; detail: D | undefined },
  space: SpaceReport | undefined,
): { conversation: C | undefined; detail: D | undefined } {
  if (!space) return menu;
  return {
    conversation: menu.conversation && {
      ...menu.conversation,
      archivedAt: space.archivedAt,
    },
    detail: menu.detail && {
      ...menu.detail,
      isParticipant: space.viewerIsMember,
      subscribed: space.viewerIsMember,
    },
  };
}
