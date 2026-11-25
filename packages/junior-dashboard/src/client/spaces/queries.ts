import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  conversationFeedSchema,
  setConversationSpaceResponseSchema,
  spaceListSchema,
  spaceMemberListSchema,
  spaceSchema,
  type SpaceReport,
} from "@sentry/junior/api/schema";

import { invalidateConversationFeeds } from "../conversations/conversationFeedCache";
import { conversationDetailQueryKey } from "../conversations/queries";
import { del, fetchDashboardJson, patch, post, put } from "../http";

const spacesKey = ["dashboard", "spaces"] as const;
const memberSpacesKey = [...spacesKey, "member"] as const;
const spaceKey = (spaceId: string | undefined) =>
  [...spacesKey, "space", spaceId] as const;
const spaceMembersKey = (spaceId: string | undefined) =>
  [...spaceKey(spaceId), "members"] as const;

/** The query key of a Space's Lead. */
export const spaceLeadKey = (spaceId: string | undefined) =>
  [...spaceKey(spaceId), "lead"] as const;

/** The API path of one Space. */
export const spaceApiPath = (spaceId: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}`;

/** Fetch the viewer's Spaces that are not archived, for the pane. */
export function useMemberSpacesData(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: memberSpacesKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(spaceListSchema, "/api/spaces", signal),
    retry: false,
  });
}

/** Fetch one Space. Every Space is public, so anyone can read it. */
export function useSpaceData(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: spaceKey(spaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(spaceSchema, spaceApiPath(spaceId!), signal),
    retry: false,
  });
}

/** Fetch the members of one Space. */
export function useSpaceMembersData(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: spaceMembersKey(spaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        spaceMemberListSchema,
        `${spaceApiPath(spaceId!)}/members`,
        signal,
      ),
    retry: false,
  });
}

/**
 * Fetch the top-level Conversations of one Space. The key is under the
 * Conversation feeds, so every change to a Conversation refreshes it.
 */
export function useSpaceConversationsData(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: ["dashboard", "conversations", "space", { spaceId }],
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationFeedSchema,
        `/api/conversations?${new URLSearchParams({ spaceId: spaceId! })}`,
        signal,
      ),
    retry: false,
  });
}

/** Put the changed Space in its cache and refresh the pane's list. */
function storeSpace(queryClient: QueryClient, space: SpaceReport) {
  queryClient.setQueryData(spaceKey(space.id), space);
  return queryClient.invalidateQueries({ queryKey: memberSpacesKey });
}

/** Create a Space. The creator is its first member. */
export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { description: string | null; name: string }) =>
      post(spaceSchema, "/api/spaces", body),
    onSuccess: (space) => storeSpace(queryClient, space),
  });
}

/**
 * Join or leave one Space as the viewer. A member's read makes the Lead, so
 * the Lead reads again too.
 */
export function useSpaceMembership(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (join: boolean) =>
      join
        ? put(spaceSchema, `${spaceApiPath(spaceId)}/members/me`, {})
        : del(spaceSchema, `${spaceApiPath(spaceId)}/members/me`),
    onSuccess: (space) =>
      Promise.all([
        storeSpace(queryClient, space),
        queryClient.invalidateQueries({ queryKey: spaceMembersKey(spaceId) }),
        queryClient.invalidateQueries({ queryKey: spaceLeadKey(spaceId) }),
      ]),
  });
}

/**
 * Archive or restore one Space. Archive also archives and stops its
 * Conversations, so the feeds refresh too.
 */
export function useArchiveSpace(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) =>
      patch(spaceSchema, `${spaceApiPath(spaceId)}/archive`, { archived }),
    onSuccess: (space) =>
      Promise.all([
        storeSpace(queryClient, space),
        invalidateConversationFeeds(queryClient),
      ]),
  });
}

/** Put one top-level Conversation in a Space, or in none with null. */
export function useMoveConversationToSpace(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string | null) =>
      put(
        setConversationSpaceResponseSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/space`,
        { spaceId },
      ),
    onSuccess: () =>
      Promise.all([
        invalidateConversationFeeds(queryClient),
        queryClient.invalidateQueries({
          queryKey: conversationDetailQueryKey(conversationId),
        }),
      ]),
  });
}
