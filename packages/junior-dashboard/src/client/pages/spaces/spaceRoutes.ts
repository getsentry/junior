/** Dashboard path for one Space. */
export function spacePath(spaceId: string): string {
  return `/spaces/${encodeURIComponent(spaceId)}`;
}
