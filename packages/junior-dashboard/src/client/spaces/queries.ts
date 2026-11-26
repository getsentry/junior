import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  conversationFeedSchema,
  conversationLeaveResponseSchema,
  leadSchema,
  setConversationSpaceResponseSchema,
  spaceListSchema,
  spaceSchema,
  type SpaceReport,
  type SpaceVisibilityReport,
} from "@sentry/junior/api/schema";

import { invalidateConversationFeeds } from "../conversations/conversationFeedCache";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "../conversations/queries";
import { fetchDashboardJson, patch, post, put } from "../http";
import { invalidateInboxItemCollections } from "../inbox/queries";

const spacesKey = ["dashboard", "spaces"] as const;
const memberSpacesKey = [...spacesKey, "member"] as const;
const spaceKey = (spaceId: string | undefined) =>
  [...spacesKey, "space", spaceId] as const;

/** The query of a Space's Lead. The Lead's id never changes. */
export function spaceLeadQuery(spaceId: string) {
  return {
    queryKey: [...spaceKey(spaceId), "lead"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchDashboardJson(leadSchema, `${spaceApiPath(spaceId)}/lead`, signal),
    staleTime: Number.POSITIVE_INFINITY,
  };
}

/** The API path of one Space. */
const spaceApiPath = (spaceId: string) =>
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
 * Read again the cached details of each Conversation in one Space. Returns
 * one read per detail, for the caller's `Promise.all`.
 */
function invalidateSpaceDetails(queryClient: QueryClient, spaceId: string) {
  return queryClient
    .getQueriesData<ConversationSnapshot | undefined>({
      queryKey: ["conversation"],
    })
    .filter(
      ([queryKey, detail]) =>
        queryKey[2] === "detail" && detail?.space?.id === spaceId,
    )
    .map(([queryKey]) =>
      queryClient.invalidateQueries({ queryKey, exact: true }),
    );
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
 * Rename a Space or change its description. Conversation rows and details
 * show the Space's name, and its Lead has the same name, so they read again.
 */
export function useUpdateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      spaceId,
      ...body
    }: {
      description?: string | null;
      name: string;
      spaceId: string;
    }) => patch(spaceSchema, spaceApiPath(spaceId), body),
    onSuccess: (space) =>
      Promise.all([
        storeSpace(queryClient, space),
        invalidateConversationFeeds(queryClient),
        ...invalidateSpaceDetails(queryClient, space.id),
      ]),
  });
}

/**
 * Leave one Space as the viewer: Leave its Lead, as any root. A former
 * member can't read a private Space, so this drops everything cached for it
 * and reads the feeds and Inbox again without its rows.
 */
export function useLeaveSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (space: SpaceReport) => {
      const lead = await queryClient.fetchQuery(spaceLeadQuery(space.id));
      await post(
        conversationLeaveResponseSchema,
        `/api/conversations/${encodeURIComponent(lead.conversationId)}/leave`,
        {},
      );
      return lead.conversationId;
    },
    onSuccess: (leadId, space) => {
      if (space.visibility === "private") {
        queryClient.removeQueries({ queryKey: spaceKey(space.id) });
        queryClient.removeQueries({
          queryKey: conversationDetailQueryKey(leadId),
        });
        for (const [queryKey, detail] of queryClient.getQueriesData<
          ConversationSnapshot | undefined
        >({ queryKey: ["conversation"] })) {
          if (queryKey[2] === "detail" && detail?.space?.id === space.id) {
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
        queryClient.invalidateQueries({ queryKey: spaceKey(space.id) }),
        queryClient.invalidateQueries({ queryKey: memberSpacesKey }),
        queryClient.invalidateQueries({
          queryKey: conversationDetailQueryKey(leadId),
        }),
        invalidateConversationFeeds(queryClient),
      ]);
    },
  });
}

/**
 * Archive or restore one Space. Archive also archives and stops its
 * Conversations, the Lead included, so the feeds and their details refresh
 * too.
 */
export function useArchiveSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      archived,
      spaceId,
    }: {
      archived: boolean;
      spaceId: string;
    }) => patch(spaceSchema, `${spaceApiPath(spaceId)}/archive`, { archived }),
    onSuccess: (space) =>
      Promise.all([
        storeSpace(queryClient, space),
        invalidateConversationFeeds(queryClient),
        ...invalidateSpaceDetails(queryClient, space.id),
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
        // The roll-up of the Space it left and the one it joined.
        invalidateMemberSpaces(queryClient),
        queryClient.invalidateQueries({
          queryKey: conversationDetailQueryKey(conversationId),
        }),
      ]),
  });
}
