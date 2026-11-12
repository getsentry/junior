import { useState } from "react";
import { useHref } from "react-router";
import { Check, Share2 } from "lucide-react";

import { conversationPath } from "./conversationRoutes";

/**
 * Share a conversation link without changing who can access it. The label,
 * icon, and `feedback` status text name the result of the last share.
 */
export function useShareConversationLink(conversationId: string) {
  const href = useHref(conversationPath(conversationId));
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
  const feedback =
    status === "copied"
      ? "Conversation link copied. Access has not changed."
      : status === "copy-failed"
        ? "Could not copy the link. Try again or copy it from the address bar."
        : status === "share-failed"
          ? "Could not share the link. Try again or copy it from the address bar."
          : "";

  async function share() {
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

  return {
    disabled: status === "sharing",
    feedback,
    icon: status === "copied" ? Check : Share2,
    label,
    share,
  };
}
