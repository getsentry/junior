import type { ComponentProps } from "react";
import { Link, useHref } from "react-router";

import { CONVERSATION_PATH } from "../conversations/conversationRoutes";

/**
 * Open a link in message text in the same tab. A reader who wants a new tab
 * can Ctrl/⌘-click. A link to a Conversation of this dashboard, such as a
 * Thread or Task link, navigates in the app without a page load.
 */
export function SameTabLink({
  href,
  ...props
}: Omit<ComponentProps<"a">, "href" | "rel" | "target"> & { href: string }) {
  const to = dashboardRoute(href, useHref("/"));
  return to ? <Link {...props} to={to} /> : <a {...props} href={href} />;
}

// Return the router path of a same-origin Conversation link, or undefined.
// Other same-origin paths, such as files and API routes, are served outside
// the router, so they keep a plain link.
function dashboardRoute(href: string, basename: string): string | undefined {
  const origin = globalThis.location?.origin;
  if (!origin || !URL.canParse(href)) return undefined;
  const url = new URL(href);
  if (url.origin !== origin) return undefined;
  const base = basename.replace(/\/$/, "");
  if (base && !url.pathname.startsWith(`${base}/`)) return undefined;
  const path = url.pathname.slice(base.length);
  if (!CONVERSATION_PATH.test(path)) return undefined;
  return `${path}${url.search}${url.hash}`;
}
