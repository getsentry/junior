import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useLocation } from "react-router";

import { paneEntryClass } from "../inbox/PaneDestinations";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { useMemberSpacesData } from "./queries";
import { spacePath } from "./spaceRoutes";
import { SpaceTile } from "./SpaceTile";

// The dialog opens only after a click, so it loads with the first open
// instead of with every page.
const CreateSpaceDialog = lazy(() =>
  import("./CreateSpaceDialog").then((module) => ({
    default: module.CreateSpaceDialog,
  })),
);

/**
 * The pane's Spaces: each Space that the viewer is a member of, one click
 * away, and a way to create one.
 */
export function SpacesNav(props: { phone?: boolean; signedIn: boolean }) {
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
          {spaces.data.spaces.map((space) => {
            const current = pathname === spacePath(space.id);
            return (
              <li className="list-none" key={space.id}>
                <Link
                  aria-current={current ? "page" : undefined}
                  className={paneEntryClass(
                    current ? "page" : undefined,
                    props.phone,
                  )}
                  to={spacePath(space.id)}
                >
                  <SpaceTile
                    className="justify-self-center"
                    size="sm"
                    space={space}
                  />
                  <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
                    {space.name}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {creating ? (
        <Suspense fallback={null}>
          <CreateSpaceDialog onClose={() => setCreating(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
