import { useMutation } from "@tanstack/react-query";

import { dashboardIdentitySchema } from "../../api/schema";
import { InlineError } from "../components/InlineError";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "../components/ui/empty";
import { patch } from "../http";

/**
 * Render the new dashboard UI for users who turned on `experimentalUi`.
 * Until it lands, it only lets the user go back to the current UI.
 */
export function InboxShell() {
  const leave = useMutation({
    mutationFn: () =>
      patch(dashboardIdentitySchema, "/api/me", { experimentalUi: false }),
    // The page picks its shell when it loads.
    onSuccess: () => window.location.reload(),
  });
  return (
    <main className="grid min-h-dvh place-items-center bg-dashboard-bg p-8 font-sans text-dashboard-text-solid">
      <Empty className="grid w-full max-w-md gap-3 p-6">
        <EmptyTitle>The new dashboard is coming soon</EmptyTitle>
        <EmptyDescription>
          Use the current dashboard until then.
        </EmptyDescription>
        <div>
          <Button disabled={leave.isPending} onClick={() => leave.mutate()}>
            Use the current dashboard
          </Button>
        </div>
        {leave.error ? <InlineError>{leave.error.message}</InlineError> : null}
      </Empty>
    </main>
  );
}
