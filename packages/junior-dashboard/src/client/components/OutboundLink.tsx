import { ExternalLink } from "lucide-react";
import type { ComponentProps } from "react";

/** Mark a link that opens in a new tab. Sizes with the link text. */
export function OutboundIcon() {
  return (
    <ExternalLink
      aria-hidden="true"
      className="ml-1 inline size-[0.8em] shrink-0 align-[-0.05em] opacity-60"
    />
  );
}

/** Open a link in a new tab, with the outbound icon after its content. */
export function OutboundLink({
  children,
  ...props
}: Omit<ComponentProps<"a">, "rel" | "target">) {
  return (
    <a {...props} rel="noreferrer" target="_blank">
      {children}
      <OutboundIcon />
    </a>
  );
}
