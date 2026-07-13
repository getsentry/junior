import { Search } from "lucide-react";

import { cn } from "../styles";

/** Render the dashboard's compact conversation search input. */
export function ConversationSearchInput(props: {
  className?: string;
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className={cn("relative min-w-0", props.className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555]"
        size={13}
        strokeWidth={2.5}
      />
      <input
        aria-label={props.label}
        className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/25 pl-8 pr-3 font-mono text-[0.74rem] text-white/75 outline-none transition-colors placeholder:text-white/20 hover:border-white/15 focus:border-cyan-400/30 focus:ring-1 focus:ring-cyan-400/15"
        placeholder={props.placeholder}
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}
