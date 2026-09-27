import { useState } from "react";
import { useHref } from "react-router";
import { Check, Share2 } from "lucide-react";

import { Button } from "../components/Button";
import { conversationPath } from "./conversationRoutes";

/** Share a conversation link without changing who can access it. */
export function ShareConversationButton(props: {
  conversationId: string;
  layout?: "button" | "menu";
}) {
  const href = useHref(conversationPath(props.conversationId));
  const [status, setStatus] = useState<
    "idle" | "sharing" | "copied" | "copy-failed" | "share-failed"
  >("idle");
  const label =
    status === "copied"
      ? "Link copied"
      : status === "copy-failed"
        ? "Copy failed — retry"
        : status === "share-failed"
          ? "Share failed — retry"
          : "Share";
  const Icon = status === "copied" ? Check : Share2;
  const feedback =
    status === "copied"
      ? "Conversation link copied. Access has not changed."
      : status === "copy-failed"
        ? "Could not copy the link. Try again or copy it from the address bar."
        : status === "share-failed"
          ? "Could not share the link. Try again or copy it from the address bar."
          : "";

  async function shareLink() {
    setStatus("sharing");
    const url = new URL(href, window.location.origin).href;
    // Touch-first devices use the native sheet, including tablets. Desktop
    // browsers keep copy-link behavior even when they support native sharing.
    if (
      window.matchMedia("(pointer: coarse)").matches &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({ url });
        setStatus("idle");
      } catch (error) {
        // Dismissing the sheet must not copy a link or show an error.
        setStatus(
          error instanceof DOMException && error.name === "AbortError"
            ? "idle"
            : "share-failed",
        );
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("copy-failed");
    }
  }

  const content = (
    <>
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
      <span>{label}</span>
    </>
  );
  const button =
    props.layout === "menu" ? (
      <button
        aria-label={label}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={status === "sharing"}
        onClick={() => void shareLink()}
        type="button"
      >
        {content}
      </button>
    ) : (
      <Button
        aria-label={label}
        disabled={status === "sharing"}
        onClick={() => void shareLink()}
      >
        {content}
      </Button>
    );

  return (
    <>
      {button}
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </>
  );
}
