import type { Ref } from "react";
import { Search, X } from "lucide-react";

import { cn } from "../styles";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./ui/input-group";

type SearchInputSize = "compact" | "default";

/** Render the dashboard's standard search input with distinct value and placeholder text. */
export function SearchInput(props: {
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  onChange(value: string): void;
  placeholder: string;
  size?: SearchInputSize;
  value: string;
}) {
  const size = sizeClass[props.size ?? "compact"];
  return (
    <InputGroup className={cn(size.group, props.className)}>
      <InputGroupInput
        aria-label={props.label}
        className={cn(
          "[&::-webkit-search-cancel-button]:appearance-none",
          size.input,
        )}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.placeholder}
        ref={props.inputRef}
        type="search"
        value={props.value}
      />
      <InputGroupAddon className={size.icon}>
        <Search aria-hidden="true" size={size.iconSize} strokeWidth={2.5} />
      </InputGroupAddon>
      {/* The clear button keeps its space while hidden, so the field width does not change. */}
      <InputGroupAddon align="inline-end" className={size.clear}>
        <InputGroupButton
          aria-label="Clear search"
          className={props.value ? undefined : "invisible"}
          onClick={(event) => {
            props.onChange("");
            // The button hides once the value is empty, so keep focus in the search box.
            event.currentTarget
              .closest("[data-slot=input-group]")
              ?.querySelector("input")
              ?.focus();
          }}
        >
          <X aria-hidden="true" size={14} strokeWidth={2.5} />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

// Match the icon, text, and clear button offsets of the bordered input.
const sizeClass: Record<
  SearchInputSize,
  {
    clear: string;
    group: string;
    icon: string;
    iconSize: number;
    input: string;
  }
> = {
  compact: {
    clear: "pr-1.25",
    group: "h-9",
    icon: "pl-2.25",
    iconSize: 13,
    input: "pr-1 pl-2.5",
  },
  default: {
    clear: "pr-1.75",
    group: "h-10",
    icon: "pl-2.75",
    iconSize: 14,
    input: "pr-1 pl-2.75",
  },
};
