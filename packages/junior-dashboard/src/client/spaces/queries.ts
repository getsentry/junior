import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  conversationFeedSchema,
  setConversationSpaceResponseSchema,
  spaceConfigurationSchema,
  spaceListSchema,
  spaceMemberListSchema,
  spaceSchema,
  type SpaceReport,
  type SpaceVisibilityReport,
} from "@sentry/junior/api/schema";

import { invalidateConversationFeeds } from "../conversations/conversationFeedCache";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import { del, fetchDashboardJson, patch, post, put } from "../http";
import { invalidateInboxItemCollections } from "../inbox/queries";

const spacesKey = ["dashboard", "spaces"] as const;
const memberSpacesKey = [...spacesKey, "member"] as const;
const spaceKey = (spaceId: string | undefined) =>
  [...spacesKey, "space", spaceId] as const;
const spaceMembersKey = (spaceId: string | undefined) =>
  [...spaceKey(spaceId), "members"] as const;
const spaceConfigurationKey = (spaceId: string | undefined) =>
  [...spaceKey(spaceId), "configuration"] as const;

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

/**
 * Refresh the pane's Spaces, whose rows roll up the state of their
 * Conversations.
 */
export function invalidateMemberSpaces(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: memberSpacesKey });
}

/**
 * Fetch one Space. Anyone can read a public Space, and only members read a
 * private one.
 */
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

/** Fetch a Space's configuration. */
export function useSpaceConfigurationData(spaceId: string | undefined) {
  return useQuery({
    enabled: Boolean(spaceId),
    queryKey: spaceConfigurationKey(spaceId),
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        spaceConfigurationSchema,
        `${spaceApiPath(spaceId!)}/configuration`,
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
    mutationFn: (body: {
      description: string | null;
      name: string;
      visibility: SpaceVisibilityReport;
    }) => post(spaceSchema, "/api/spaces", body),
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
    onSuccess: (space) => {
      // A former member can't read a private Space, so drop everything
      // cached for it and read the feeds and Inbox again without its rows.
      if (space.visibility === "private" && !space.viewerIsMember) {
        const lead = queryClient.getQueryData<{ conversationId: string }>(
          spaceLeadKey(spaceId),
        );
        queryClient.removeQueries({ queryKey: spaceKey(spaceId) });
        if (lead) {
          queryClient.removeQueries({
            queryKey: conversationDetailQueryKey(lead.conversationId),
          });
        }
        for (const [queryKey, detail] of queryClient.getQueriesData<
          ConversationSnapshot | undefined
        >({ queryKey: ["conversation"] })) {
          if (queryKey[2] === "detail" && detail?.space?.id === spaceId) {
            queryClient.removeQueries({ queryKey, exact: true });
          }
        }
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: memberSpacesKey }),
          invalidateConversationFeeds(queryClient),
          invalidateInboxItemCollections(queryClient),
        ]);
      }
      return Promise.all([
        storeSpace(queryClient, space),
        queryClient.invalidateQueries({ queryKey: spaceMembersKey(spaceId) }),
        queryClient.invalidateQueries({ queryKey: spaceLeadKey(spaceId) }),
      ]);
    },
  });
}

/** Add one person to a Space by their email. */
export function useAddSpaceMember(spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      post(spaceSchema, `${spaceApiPath(spaceId)}/members`, { email }),
    onSuccess: (space) =>
      Promise.all([
        storeSpace(queryClient, space),
        queryClient.invalidateQueries({ queryKey: spaceMembersKey(spaceId) }),
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
