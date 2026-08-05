import { cn } from "../styles";

/** Render the animated dot used to show active work. */
export function ActiveIndicator(props: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "shrink-0 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.55)] animate-[junior-active-indicator_1.8s_ease-in-out_infinite] motion-reduce:animate-none",
        props.className,
      )}
    />
  );
}
