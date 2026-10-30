import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

/** Show an actor's image, with initials when the image is missing or fails. */
export function ActorAvatar(props: {
  name: string;
  imageUrl?: string;
  size: "detail" | "list";
}) {
  const words = props.name.trim().split(/\s+/).filter(Boolean);
  // The compact size fits one initial at the 12px type floor.
  const initials =
    props.size === "list"
      ? props.name.trim().slice(0, 1)
      : words.length > 1
        ? `${words[0]![0]}${words.at(-1)![0]}`
        : props.name.slice(0, 2);
  return (
    <Avatar aria-hidden="true" size={props.size === "list" ? "sm" : "default"}>
      <AvatarImage
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        src={props.imageUrl}
      />
      <AvatarFallback>{initials.toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
