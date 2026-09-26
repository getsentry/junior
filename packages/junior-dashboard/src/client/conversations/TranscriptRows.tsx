import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../styles";

/** Keep row padding and the gap between transcript entries in one place. */
export function TranscriptRows({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1", className)}
    />
  );
}

/** Leave room for control outlines inside the mobile row's paint bounds. */
export function TranscriptRow(props: {
  children: ReactNode;
  indent?: boolean;
}) {
  return (
    <div className="mobile-transcript-row -mx-2 px-2 py-1.5">
      {props.indent ? (
        <div className="pl-11">{props.children}</div>
      ) : (
        props.children
      )}
    </div>
  );
}
