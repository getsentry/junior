import { useState, type ReactNode } from "react";

import { useDashboardCoreData } from "../api";
import { cn } from "../styles";
import { usePlainLinks } from "./linkMode";

/**
 * Show one person in running text the way GitHub shows a mention: a small
 * round photo at text height, then the name. A mention of the viewer gets a
 * subtle highlight and `data-self-mention`. Plain links show no photo.
 */
export function PersonMention(props: {
  avatarUrl?: string;
  children: ReactNode;
  email?: string;
}) {
  const viewer = useDashboardCoreData().data?.me.user.email;
  const avatarUrl = usePlainLinks() ? undefined : props.avatarUrl;
  const self = Boolean(
    viewer && props.email?.toLowerCase() === viewer.toLowerCase(),
  );
  if (!self && !avatarUrl) return props.children;
  return (
    <span
      className={cn(
        "whitespace-nowrap",
        self && "rounded-sm bg-dashboard-accent/15 px-0.5",
      )}
      data-self-mention={self ? "" : undefined}
    >
      {avatarUrl ? <PersonAvatar src={avatarUrl} /> : null}
      {props.children}
    </span>
  );
}

// A photo that fails to load does not render, so the name stands alone.
function PersonAvatar(props: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt=""
      className="mr-1 inline-block size-[1em] rounded-full object-cover align-[-0.125em]"
      loading="lazy"
      onError={() => setFailed(true)}
      src={props.src}
    />
  );
}
