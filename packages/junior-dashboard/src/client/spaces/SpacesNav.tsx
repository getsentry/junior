import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useLocation } from "react-router";
import type { SpaceReport } from "@sentry/junior/api/schema";

import {
  browserMenuOnLinks,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { paneEntryClass } from "../inbox/PaneDestinations";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { useMemberSpacesData } from "./queries";
import { useSpaceActions } from "./SpaceActions";
import { spacePath } from "./spaceRoutes";
import { SpaceStateIcon, spaceDisplayState } from "./SpaceStateIcon";
import { ConversationIcon } from "../conversations/ConversationIcon";

// The dialog opens only after a click, so it loads with the first open
// instead of with every page.
const SpaceFormDialog = lazy(() =>
  import("./SpaceFormDialog").then((module) => ({
    default: module.SpaceFormDialog,
  })),
);

/** One of the viewer's Spaces in the pane. Its context menu acts on it. */
function SpaceNavRow(props: {
  current: boolean;
  phone?: boolean | undefined;
  space: SpaceReport;
}) {
  const { space } = props;
  const actions = useSpaceActions(space);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        {...browserMenuOnLinks}
        className="group list-none"
        render={<li />}
      >
        <Link
          aria-current={props.current ? "page" : undefined}
          className={cn(
            paneEntryClass(props.current ? "page" : undefined, props.phone),
            // The row shows which Space its open menu acts on.
            !props.current && "group-data-popup-open:bg-dashboard-fill-hover",
            // A long press opens the row menu, not the iOS link callout.
            "[-webkit-touch-callout:none]",
          )}
          data-row-menu=""
          to={spacePath(space.id)}
        >
          <ConversationIcon
            className="justify-self-center"
            iconId={space.id}
            name={space.name}
            size="sm"
            visibility={space.visibility}
          />
          <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
            {space.name}
          </span>
          <SpaceStateIcon state={spaceDisplayState(space)} />
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent>{actions.rows}</ContextMenuContent>
      {actions.dialogs}
    </ContextMenu>
  );
}

/**
 * The pane's Spaces: each Space that the viewer is a member of, one click
 * away, with the state of its Conversations, and a way to create one. A
 * Space's context menu edits, archives, or leaves it.
 */
export function SpacesNav(props: {
  /** The Space of the open Conversation, which marks its row. */
  conversationSpaceId?: string;
  phone?: boolean;
  signedIn: boolean;
}) {
  const { pathname } = useLocation();
  const spaces = useMemberSpacesData(props.signedIn);
  const [creating, setCreating] = useState(false);
  if (!props.signedIn) return null;
  return (
    <>
      <h2 className="m-0 flex items-center justify-between px-3 pt-5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
        Spaces
        <button
          aria-label="New Space"
          className="-my-1 -mr-1 grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={() => setCreating(true)}
          title="New Space"
          type="button"
        >
          <Plus aria-hidden="true" size={14} />
        </button>
      </h2>
      {spaces.data && spaces.data.spaces.length > 0 ? (
        <ul aria-label="Spaces" className="m-0 grid gap-0.5 p-0">
          {spaces.data.spaces.map((space) => (
            <SpaceNavRow
              current={
                pathname === spacePath(space.id) ||
                space.id === props.conversationSpaceId
              }
              key={space.id}
              phone={props.phone}
              space={space}
            />
          ))}
        </ul>
      ) : null}
      {creating ? (
        <Suspense fallback={null}>
          <SpaceFormDialog onClose={() => setCreating(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
