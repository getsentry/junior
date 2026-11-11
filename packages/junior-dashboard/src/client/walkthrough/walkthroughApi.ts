import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { walkthroughVersionSchema } from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { useToastManager } from "../components/ui/toast";
import { fetchDashboardJson, post } from "../http";
import type { WalkthroughTarget } from "./walkthroughModel";

const GENERATING_POLL_MS = 3_000;

function walkthroughQueryKey(id: string | undefined) {
  return ["dashboard", "walkthrough", id] as const;
}

/** Fetch one Walkthrough version. A generating version polls until it ends. */
export function useWalkthroughData(id: string | undefined) {
  return useQuery({
    enabled: Boolean(id),
    queryKey: walkthroughQueryKey(id),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        walkthroughVersionSchema,
        `/api/walkthroughs/${encodeURIComponent(id ?? "")}`,
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "generating" ? GENERATING_POLL_MS : false,
    retry: false,
  });
}

/** Whether the app enables Walkthroughs. Entry points render only then. */
export function useWalkthroughsEnabled(): boolean {
  return useDashboardCoreData().data?.config.walkthroughs === true;
}

/**
 * Start a Walkthrough of a code change and open its page. The same commits
 * get the same version, so a second click opens the first one.
 */
export function useStartWalkthrough() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toasts = useToastManager();
  return useMutation({
    mutationFn: (target: WalkthroughTarget) =>
      post(walkthroughVersionSchema, "/api/walkthroughs", target),
    onSuccess: (version) => {
      queryClient.setQueryData(walkthroughQueryKey(version.id), version);
      void navigate(`/walkthroughs/${encodeURIComponent(version.id)}`);
    },
    onError: () => {
      toasts.add({ title: "Could not start the Walkthrough", type: "error" });
    },
  });
}
