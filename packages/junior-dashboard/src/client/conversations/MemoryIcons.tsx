import { ArrowUpRight, Lock } from "lucide-react";

/** Mark a memory that only its owner can see. */
export function PrivateMemoryIcon() {
  return <Lock aria-label="Private" role="img" size={13} strokeWidth={1.8} />;
}

/**
 * End a memory row that links to the memory's page. Its parent link needs
 * the `group` class, so the arrow follows the row hover.
 */
export function MemoryLinkIcons(props: { private: boolean }) {
  return (
    <span className="flex items-center gap-1.5 pt-1 text-dashboard-text-faint">
      {props.private ? <PrivateMemoryIcon /> : null}
      <ArrowUpRight
        aria-hidden="true"
        className="transition-colors group-hover:text-dashboard-text"
        size={14}
      />
    </span>
  );
}
