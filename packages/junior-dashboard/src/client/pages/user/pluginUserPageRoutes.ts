/** Build the canonical dashboard path for a plugin-owned page. */
export function pluginUserPagePath(pluginName: string, pageId: string): string {
  if (pluginName === "memory" && pageId === "memories") return "/memories";
  return `/plugins/${encodeURIComponent(pluginName)}/${encodeURIComponent(pageId)}`;
}

const PLUGIN_PAGE_PATH = /^\/plugins\/([^/]+)\/([^/]+)$/;

/**
 * Build the content API path of a generic plugin page from its dashboard
 * path. Both paths hold the same encoded segments. Returns undefined for
 * other paths, such as the memory library's first-class route.
 */
export function pluginUserPageApiPath(pagePath: string): string | undefined {
  const match = PLUGIN_PAGE_PATH.exec(pagePath);
  return match ? `/api/user-pages/${match[1]}/${match[2]}` : undefined;
}

/** Build the path that opens a plugin page at one of its records. */
export function pluginUserPageRecordPath(
  pagePath: string,
  recordId: string,
): string {
  return `${pagePath}#${encodeURIComponent(pluginUserPageRecordAnchor(recordId))}`;
}

/** Element ID of one record row on a plugin page. */
export function pluginUserPageRecordAnchor(recordId: string): string {
  return `record-${recordId}`;
}
