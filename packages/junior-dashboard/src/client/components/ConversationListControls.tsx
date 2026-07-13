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
        className="h-9 w-full rounded-md border border-white/15 bg-[#0b0b0b] pl-8 pr-3 text-[0.82rem] text-[#d6d6d6] outline-none transition-colors placeholder:text-[#555] hover:border-white/30 focus:border-[#beaaff]/45 focus:ring-1 focus:ring-[#beaaff]/20"
        placeholder={props.placeholder}
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}
