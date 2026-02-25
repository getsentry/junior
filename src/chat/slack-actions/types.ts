export interface ListColumnMap {
  titleColumnId?: string;
  completedColumnId?: string;
  assigneeColumnId?: string;
  dueDateColumnId?: string;
}

export interface ThreadArtifactsState {
  lastCanvasId?: string;
  lastListId?: string;
  listColumnMap?: ListColumnMap;
  updatedAt?: string;
}

export function coerceThreadArtifactsState(value: unknown): ThreadArtifactsState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const raw = value as {
    artifacts?: {
      lastCanvasId?: unknown;
      lastListId?: unknown;
      listColumnMap?: {
        titleColumnId?: unknown;
        completedColumnId?: unknown;
        assigneeColumnId?: unknown;
        dueDateColumnId?: unknown;
      };
      updatedAt?: unknown;
    };
  };

  const artifacts = raw.artifacts ?? {};
  const listColumnMap = artifacts.listColumnMap ?? {};

  return {
    lastCanvasId: typeof artifacts.lastCanvasId === "string" ? artifacts.lastCanvasId : undefined,
    lastListId: typeof artifacts.lastListId === "string" ? artifacts.lastListId : undefined,
    listColumnMap: {
      titleColumnId: typeof listColumnMap.titleColumnId === "string" ? listColumnMap.titleColumnId : undefined,
      completedColumnId:
        typeof listColumnMap.completedColumnId === "string" ? listColumnMap.completedColumnId : undefined,
      assigneeColumnId:
        typeof listColumnMap.assigneeColumnId === "string" ? listColumnMap.assigneeColumnId : undefined,
      dueDateColumnId: typeof listColumnMap.dueDateColumnId === "string" ? listColumnMap.dueDateColumnId : undefined
    },
    updatedAt: typeof artifacts.updatedAt === "string" ? artifacts.updatedAt : undefined
  };
}

export function buildArtifactStatePatch(patch: Partial<ThreadArtifactsState>): {
  artifacts: ThreadArtifactsState;
} {
  return {
    artifacts: {
      ...patch,
      updatedAt: new Date().toISOString()
    }
  };
}
