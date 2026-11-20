import { Ellipsis } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { HeaderIconButton } from "./ConversationHeaderActions";

/**
 * Show the conversation `⋯` button and its menu. `children` are the menu
 * rows. The menu returns focus to the button when it closes.
 */
export function ConversationOverflowMenu(props: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    // Not modal, so the page keeps scrolling while the menu is open.
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        ref={props.buttonRef}
        render={
          <HeaderIconButton
            label={open ? "Close conversation menu" : "Conversation menu"}
            tooltipDisabled={open}
          >
            <Ellipsis aria-hidden="true" size={18} strokeWidth={2} />
          </HeaderIconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
