/** Build the canonical dashboard path for a plugin-owned page. */
export function pluginUserPagePath(pluginName: string, pageId: string): string {
  if (pluginName === "memory" && pageId === "memories") return "/memories";
  return `/plugins/${encodeURIComponent(pluginName)}/${encodeURIComponent(pageId)}`;
}
