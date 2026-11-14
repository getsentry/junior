import { useState } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";

import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Copy available text and name the result: the label and icon change while
 * the copy runs and after it ends.
 */
export function useCopyText(props: {
  getText?: (() => Promise<string> | string) | undefined;
  label: string;
  copyingLabel?: string;
}) {
  const [status, setStatus] = useState<
    "copied" | "copying" | "failed" | "idle"
  >("idle");
  const label =
    status === "copied"
      ? "Copied"
      : status === "copying"
        ? (props.copyingLabel ?? "Copying")
        : status === "failed"
          ? "Copy failed"
          : props.label;
  const icon = {
    copied: Check,
    copying: Copy,
    failed: CircleAlert,
    idle: Copy,
  }[status];

  async function copy() {
    if (!props.getText) return;

    try {
      setStatus("copying");
      await navigator.clipboard.writeText(await props.getText());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return {
    copy,
    disabled: !props.getText || status === "copying",
    failed: status === "failed",
    icon,
    label,
  };
}

/** Copy available text and show whether the clipboard write succeeded. */
export function CopyButton(props: {
  getText?: (() => Promise<string> | string) | undefined;
  label: string;
  copyingLabel?: string;
}) {
  const { copy, disabled, failed, icon: Icon, label } = useCopyText(props);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            focusableWhenDisabled
            aria-label={label}
            disabled={disabled}
            onClick={() => void copy()}
            size="icon"
          >
            <Icon
              aria-hidden="true"
              className={failed ? "text-rose-300" : undefined}
              size={15}
              strokeWidth={2}
            />
          </Button>
        }
      />
      <TooltipContent size="compact">{label}</TooltipContent>
    </Tooltip>
  );
}
