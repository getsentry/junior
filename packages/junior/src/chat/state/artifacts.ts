export interface ListColumnMap {
  titleColumnId?: string;
  completedColumnId?: string;
  assigneeColumnId?: string;
  dueDateColumnId?: string;
}

export interface CanvasArtifactSummary {
  id: string;
  title?: string;
  url?: string;
  createdAt?: string;
}

export interface CardMessageEntry {
  entityKey: string;
  messageId: string;
  channelMessageTs?: string;
  pluginName: string;
  postedAt: string;
}

export interface ThreadArtifactsState {
  assistantContextChannelId?: string;
  lastCanvasId?: string;
  lastCanvasUrl?: string;
  recentCanvases?: CanvasArtifactSummary[];
  lastListId?: string;
  lastListUrl?: string;
  listColumnMap?: ListColumnMap;
  cardMessages?: CardMessageEntry[];
  updatedAt?: string;
}

/** Safely coerce an unknown value into a ThreadArtifactsState, discarding invalid fields. */
export function coerceThreadArtifactsState(
  value: unknown,
): ThreadArtifactsState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const raw = value as {
    artifacts?: {
      assistantContextChannelId?: unknown;
      lastCanvasId?: unknown;
      lastCanvasUrl?: unknown;
      recentCanvases?: unknown;
      lastListId?: unknown;
      lastListUrl?: unknown;
      listColumnMap?: {
        titleColumnId?: unknown;
        completedColumnId?: unknown;
        assigneeColumnId?: unknown;
        dueDateColumnId?: unknown;
      };
      cardMessages?: unknown;
      updatedAt?: unknown;
    };
  };

  const artifacts = raw.artifacts ?? {};
  const listColumnMap = artifacts.listColumnMap ?? {};
  const recentCanvases: CanvasArtifactSummary[] = [];
  if (Array.isArray(artifacts.recentCanvases)) {
    for (const entry of artifacts.recentCanvases) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidate = entry as {
        id?: unknown;
        title?: unknown;
        url?: unknown;
        createdAt?: unknown;
      };
      if (
        typeof candidate.id !== "string" ||
        candidate.id.trim().length === 0
      ) {
        continue;
      }
      recentCanvases.push({
        id: candidate.id,
        title:
          typeof candidate.title === "string" ? candidate.title : undefined,
        url: typeof candidate.url === "string" ? candidate.url : undefined,
        createdAt:
          typeof candidate.createdAt === "string"
            ? candidate.createdAt
            : undefined,
      });
    }
  }

  const cardMessages: CardMessageEntry[] = [];
  if (Array.isArray(artifacts.cardMessages)) {
    for (const entry of artifacts.cardMessages) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidate = entry as {
        entityKey?: unknown;
        messageId?: unknown;
        channelMessageTs?: unknown;
        pluginName?: unknown;
        postedAt?: unknown;
      };
      if (
        typeof candidate.entityKey === "string" &&
        candidate.entityKey.trim().length > 0 &&
        typeof candidate.messageId === "string" &&
        candidate.messageId.trim().length > 0 &&
        typeof candidate.pluginName === "string" &&
        candidate.pluginName.trim().length > 0 &&
        typeof candidate.postedAt === "string"
      ) {
        cardMessages.push({
          entityKey: candidate.entityKey,
          messageId: candidate.messageId,
          channelMessageTs:
            typeof candidate.channelMessageTs === "string" &&
            candidate.channelMessageTs.trim().length > 0
              ? candidate.channelMessageTs
              : undefined,
          pluginName: candidate.pluginName,
          postedAt: candidate.postedAt,
        });
      }
    }
  }

  return {
    assistantContextChannelId:
      typeof artifacts.assistantContextChannelId === "string"
        ? artifacts.assistantContextChannelId
        : undefined,
    lastCanvasId:
      typeof artifacts.lastCanvasId === "string"
        ? artifacts.lastCanvasId
        : undefined,
    lastCanvasUrl:
      typeof artifacts.lastCanvasUrl === "string"
        ? artifacts.lastCanvasUrl
        : undefined,
    recentCanvases,
    lastListId:
      typeof artifacts.lastListId === "string"
        ? artifacts.lastListId
        : undefined,
    lastListUrl:
      typeof artifacts.lastListUrl === "string"
        ? artifacts.lastListUrl
        : undefined,
    listColumnMap: {
      titleColumnId:
        typeof listColumnMap.titleColumnId === "string"
          ? listColumnMap.titleColumnId
          : undefined,
      completedColumnId:
        typeof listColumnMap.completedColumnId === "string"
          ? listColumnMap.completedColumnId
          : undefined,
      assigneeColumnId:
        typeof listColumnMap.assigneeColumnId === "string"
          ? listColumnMap.assigneeColumnId
          : undefined,
      dueDateColumnId:
        typeof listColumnMap.dueDateColumnId === "string"
          ? listColumnMap.dueDateColumnId
          : undefined,
    },
    cardMessages: cardMessages.length > 0 ? cardMessages : undefined,
    updatedAt:
      typeof artifacts.updatedAt === "string" ? artifacts.updatedAt : undefined,
  };
}

/** Wrap a partial artifact update into the storage envelope with an updatedAt timestamp. */
export function buildArtifactStatePatch(patch: Partial<ThreadArtifactsState>): {
  artifacts: ThreadArtifactsState;
} {
  return {
    artifacts: {
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  };
}
