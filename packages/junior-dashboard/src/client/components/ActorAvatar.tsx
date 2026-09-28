import { useState } from "react";
import { cn } from "../styles";

/** Show an actor's image, with initials when the image is missing or fails. */
export function ActorAvatar(props: {
  name: string;
  imageUrl?: string;
  size: "detail" | "list";
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const words = props.name.trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]![0]}${words.at(-1)![0]}`
      : props.name.slice(0, 2);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full border-2 border-dashboard-bg bg-dashboard-focus font-sans font-bold leading-none text-dashboard-text-inverse shadow-sm",
        props.size === "list" ? "size-6 text-2xs" : "size-7 text-xs",
      )}
    >
      {initials.toUpperCase()}
      {props.imageUrl && props.imageUrl !== failedUrl ? (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          onError={() => setFailedUrl(props.imageUrl)}
          referrerPolicy="no-referrer"
          src={props.imageUrl}
        />
      ) : null}
    </span>
  );
}
