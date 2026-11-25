/** The dashboard page of one Space. */
export function spacePath(spaceId: string): string {
  return `/spaces/${encodeURIComponent(spaceId)}`;
}

/** Whether a path is a Space page. */
export function isSpacePath(pathname: string): boolean {
  return spaceIdFromPath(pathname) !== undefined;
}

/** Read the Space id of a Space page path. */
export function spaceIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/spaces\/([^/]+)$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
