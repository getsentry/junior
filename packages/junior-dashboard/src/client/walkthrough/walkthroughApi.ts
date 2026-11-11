import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  walkthroughAnswerSchema,
  walkthroughAnswersSchema,
  walkthroughVersionSchema,
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../api";
import { useToastManager } from "../components/ui/toast";
import { fetchDashboardJson, post, put } from "../http";
import type { DecisionAnswer } from "./WalkthroughDecision";
import type { AnswerMap, WalkthroughTarget } from "./walkthroughModel";

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

function answersQueryKey(id: string) {
  return ["dashboard", "walkthrough", id, "answers"] as const;
}

/** The viewer's answers on one version, by decision id. */
export function useWalkthroughAnswers(id: string): AnswerMap {
  const query = useQuery({
    queryKey: answersQueryKey(id),
    queryFn: async ({ signal }) => {
      const { answers } = await fetchDashboardJson(
        walkthroughAnswersSchema,
        `/api/walkthroughs/${encodeURIComponent(id)}/answers`,
        signal,
      );
      return Object.fromEntries(answers.map((a) => [a.decisionId, a]));
    },
  });
  return query.data ?? {};
}

/**
 * Save one answer. The page shows it at once and rolls back with a toast
 * when the save fails.
 */
export function useSaveWalkthroughAnswer(id: string) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const key = answersQueryKey(id);
  return useMutation({
    mutationFn: ({ decisionId, ...body }: DecisionAnswer) =>
      put(
        walkthroughAnswerSchema,
        `/api/walkthroughs/${encodeURIComponent(id)}/answers/${encodeURIComponent(decisionId)}`,
        body,
      ),
    onMutate: async (answer) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AnswerMap>(key);
      queryClient.setQueryData<AnswerMap>(key, {
        ...previous,
        [answer.decisionId]: { ...answer, updatedAt: new Date().toISOString() },
      });
      return { previous };
    },
    onError: (_error, _answer, context) => {
      queryClient.setQueryData(key, context?.previous);
      toasts.add({ title: "Could not save your answer", type: "error" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
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
