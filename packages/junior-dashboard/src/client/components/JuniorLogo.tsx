import juniorAvatarUrl from "../../assets/junior-avatar.webp";
import { cn } from "../styles";

/**
 * Render Junior's official avatar treatment used by the dashboard shell.
 * `sm` fits a 24px slot, such as the sidebar's icon axis.
 */
export function JuniorLogo(props: { size?: "sm" }) {
  const small = props.size === "sm";
  return (
    <div
      className={cn(
        "relative grid shrink-0 select-none place-items-center overflow-visible",
        small ? "size-6 justify-self-center" : "size-10",
      )}
    >
      <img
        alt=""
        className={cn(
          "relative max-w-none object-contain opacity-90 drop-shadow-[0_0_7px_rgba(255,255,255,0.16)]",
          small ? "size-7" : "-m-0.5 size-11",
        )}
        draggable={false}
        src={juniorAvatarUrl}
      />
    </div>
  );
}
