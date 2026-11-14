import { useState } from "react";

import { cn } from "../styles";

/**
 * Show an image of an object. The image route answers 404 to a viewer who
 * cannot see the source, so an image that fails to load does not render.
 */
export function ObjectImage(props: {
  alt?: string;
  className?: string;
  src: string;
  srcSet?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt={props.alt ?? ""}
      className={cn(
        "rounded-md border border-dashboard-border bg-dashboard-fill-faint object-cover object-top",
        props.className,
      )}
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={props.src}
      srcSet={props.srcSet}
    />
  );
}
