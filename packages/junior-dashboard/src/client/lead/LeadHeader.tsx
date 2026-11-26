import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";

import {
  MobileHeaderActionsPortal,
  MobileHeaderTitlePortal,
} from "../components/layout/DashboardChrome";
import { HeaderIconButton } from "../conversations/ConversationHeaderActions";
import { SpaceMenu } from "../spaces/SpaceActions";
import { useSpaceData } from "../spaces/queries";
import { SpaceTile } from "../spaces/SpaceTile";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

/**
 * Head a Lead with its Space: the Space's tile and name, a member's Space
 * menu, and the button that shows the Lead's details. A phone puts these
 * in its header.
 */
export function LeadHeader(props: {
  detailsOpen: boolean;
  onDetailsClick(): void;
  /** Shows or hides the conversation list when it is beside the Lead. */
  sidebarToggle?: ReactNode | undefined;
  spaceId: string | undefined;
}) {
  const space = useSpaceData(props.spaceId).data;
  const menu = space?.viewerIsMember ? <SpaceMenu space={space} /> : null;
  const detailsButton = props.detailsOpen ? null : (
    <HeaderIconButton
      expanded={false}
      label="Conversation details"
      onClick={props.onDetailsClick}
    >
      <PanelRight aria-hidden="true" size={16} strokeWidth={1.9} />
    </HeaderIconButton>
  );
  return (
    <>
      {space ? (
        <MobileHeaderTitlePortal>
          <h1 className="m-0 flex min-w-0 flex-1 items-center gap-2 font-display text-base font-medium text-dashboard-text">
            <SpaceTile size="md" space={space} />
            <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
              {space.name}
            </span>
          </h1>
        </MobileHeaderTitlePortal>
      ) : null}
      <MobileHeaderActionsPortal>
        {detailsButton}
        {menu}
      </MobileHeaderActionsPortal>
      <header className="hidden border-b border-dashboard-border bg-dashboard-bg md:block">
        <div className="flex h-header min-w-0 items-center gap-2 pr-4 pl-6">
          {props.sidebarToggle ? (
            <div className="shrink-0 empty:hidden">{props.sidebarToggle}</div>
          ) : null}
          {space ? <SpaceTile size="md" space={space} /> : null}
          <h1
            className={cn(
              fadeOverflowClass,
              "m-0 font-display text-lg font-medium tracking-[-0.01em] text-dashboard-text",
            )}
            ref={fadeWhenOverflowing}
          >
            {space?.name}
          </h1>
          <span className="flex-1" />
          {menu}
          {detailsButton}
        </div>
      </header>
    </>
  );
}
