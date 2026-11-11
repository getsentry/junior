import juniorAvatarUrl from "../../assets/junior-avatar.webp";
import { cn } from "../styles";
import { toolbarControlBoxClass } from "./ui/button";

/**
 * Render Junior's official avatar treatment used by the dashboard shell.
 * `sm` fills one toolbar control box, so it lines up with the buttons
 * beside it, such as in the pane's top row.
 */
export function JuniorLogo(props: { size?: "sm" }) {
  if (props.size === "sm")
    return (
      <img
        alt=""
        className={cn(
          toolbarControlBoxClass,
          "shrink-0 select-none object-cover opacity-90",
        )}
        draggable={false}
        src={juniorAvatarUrl}
      />
    );
  return (
    <div className="relative grid size-10 shrink-0 select-none place-items-center overflow-visible">
      <img
        alt=""
        className="relative -m-0.5 size-11 max-w-none object-contain opacity-90 drop-shadow-[0_0_7px_rgba(255,255,255,0.16)]"
        draggable={false}
        src={juniorAvatarUrl}
      />
    </div>
  );
}
