/** Browser storage key for where a Conversation opens: unread or latest. */
export const CONVERSATION_START_POSITION_STORAGE_KEY =
  "junior:conversation:start-position";

/**
 * Inline head script that starts the first detail read of a Conversation
 * page while the browser still downloads the client. Without it, that read
 * starts only after the entry module runs.
 *
 * It must ask for the exact path of the client's first read
 * (`readConversationData` with the mailbox and, by the start position, the
 * unread page). `readDashboardResponse` takes the response only for that
 * path, so a drift costs one extra read, not wrong data. The trace headers
 * join the read to the trace of the page request, as the browser SDK would.
 * Place it after the Sentry meta tags and before the stylesheet link: an
 * inline script after a stylesheet waits until the CSS loads.
 */
export function conversationOpenScript(basePath: string): string {
  return `(function () {
  var base = ${JSON.stringify(basePath)};
  var path = window.location.pathname;
  if (base !== "/") {
    if (path.indexOf(base + "/") !== 0) return;
    path = path.slice(base.length);
  }
  var match = path.match(/^\\/conversations\\/([^/]+)$/);
  if (!match || match[1] === "new") return;
  var id = match[1];
  try {
    id = decodeURIComponent(id);
  } catch (_error) {}
  var unread = true;
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(CONVERSATION_START_POSITION_STORAGE_KEY)});
    unread = !(stored && JSON.parse(stored) === "latest");
  } catch (_error) {}
  var url =
    "/api/conversations/" +
    encodeURIComponent(id) +
    (unread ? "?unreadPage=true&mailbox=true" : "?mailbox=true");
  var headers = {};
  ["sentry-trace", "baggage"].forEach(function (name) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (meta && meta.content) headers[name] = meta.content;
  });
  var response = window.fetch(url, {
    credentials: "same-origin",
    headers: headers,
  });
  // The client reports a failed read. Until it takes the response, a failure
  // must not reach the page's unhandledrejection handler.
  response.catch(function () {});
  window.__JUNIOR_DASHBOARD_EARLY_RESPONSE__ = { path: url, response: response };
})();`;
}
