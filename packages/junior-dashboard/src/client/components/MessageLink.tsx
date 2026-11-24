import type { ComponentProps } from "react";
import { Link, useHref } from "react-router";

import { CONVERSATION_PATH } from "../conversations/conversationRoutes";
import { OutboundLink } from "./OutboundLink";

/**
 * Open a link in message text. A link to another site opens in a new tab,
 * so the reader keeps the dashboard: the iOS home screen app has no back
 * button. With `icon`, it also ends with the outbound icon. A link to this
 * dashboard stays in the tab, and one to a Conversation, such as a Thread or
 * Task link, navigates in the app without a page load.
 */
export function MessageLink({
  href,
  icon,
  ...props
}: Omit<ComponentProps<"a">, "href" | "rel" | "target"> & {
  href: string;
  icon?: boolean | undefined;
}) {
  const basename = useHref("/");
  if (otherSite(href)) {
    return icon ? (
      <OutboundLink {...props} href={href} />
    ) : (
      <a {...props} href={href} rel="noreferrer" target="_blank" />
    );
  }
  const to = dashboardRoute(href, basename);
  return to ? <Link {...props} to={to} /> : <a {...props} href={href} />;
}

// Whether the link is a web page on another origin. Server rendering has no
// origin, so there every web link is on another site.
function otherSite(href: string): boolean {
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== globalThis.location?.origin;
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
