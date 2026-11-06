import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

import { textControlClass } from "./input";
import { submitFormOnModEnter } from "./submit-shortcut";

/** Render an unstyled text area. Ctrl+Enter or Cmd+Enter sends its form. */
function BareTextarea(props: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        submitFormOnModEnter(event);
      }}
    />
  );
}

/** Render a text area with the dashboard text control surface. */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <BareTextarea
      data-slot="textarea"
      className={cn(textControlClass, "min-h-36", className)}
      {...props}
    />
  );
}

export { BareTextarea, Textarea };
