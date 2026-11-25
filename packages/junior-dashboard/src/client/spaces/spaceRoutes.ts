/** The dashboard page of one Space. */
export function spacePath(spaceId: string): string {
  return `/spaces/${encodeURIComponent(spaceId)}`;
}

/** Whether a path is a Space page. */
export function isSpacePath(pathname: string): boolean {
  return /^\/spaces\/[^/]+$/.test(pathname);
}
