import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

import { textControlClass } from "./input";

/** Render a text area with the dashboard text control surface. */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textControlClass, "min-h-36", className)}
      {...props}
    />
  );
}

export { Textarea };
