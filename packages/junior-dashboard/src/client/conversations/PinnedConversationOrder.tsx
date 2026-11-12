import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDndContext,
  useSensor,
  useSensors,
  type Announcements,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable } from "@dnd-kit/sortable";
import { Pin } from "lucide-react";

import { conversationDisplayTitle } from "../format";
import type { Conversation } from "../types";
import type { ReorderPins } from "./useReorderPinnedConversations";

/** Drag state and handlers that one pinned row renders. */
export type PinnedRowDrag = {
  dragging: boolean;
  listeners: DraggableSyntheticListeners;
  onKeyDown(event: KeyboardEvent): void;
  setNodeRef(element: HTMLElement | null): void;
};

type PinnedOrder = {
  disabled: boolean;
  move(conversationId: string, toIndex: number): void;
};

const PinnedOrderContext = createContext<PinnedOrder | null>(null);

/**
 * Let the viewer drag pinned rows into a new order. Rows do not move while
 * the pointer drags: a line shows where the row lands. On drop, the list takes
 * the new order at once and the order saves in the background.
 *
 * The preview and the line render in a portal. Rows can clip their overflow
 * or sit under a transform, and either would hide them.
 */
export function PinnedConversationOrder(props: {
  children: ReactNode;
  /** Pinned conversations in their shown order. */
  conversations: Conversation[];
  onError(conversation: Conversation): void;
  /**
   * Leave unset when the list shows only some pins, such as during a search,
   * because a drop could not place the rest.
   */
  reorder?: ReorderPins;
}) {
  const { conversations, onError, reorder } = props;
  const ids = useMemo(
    () => conversations.map((conversation) => conversation.id),
    [conversations],
  );
  const move = useCallback(
    (conversationId: string, toIndex: number) => {
      const fromIndex = ids.indexOf(conversationId);
      if (fromIndex < 0 || toIndex < 0 || toIndex >= ids.length) return;
      if (fromIndex === toIndex) return;
      reorder?.({
        conversationIds: arrayMove(ids, fromIndex, toIndex),
        onError: () => onError(conversations[fromIndex]!),
      });
    },
    [conversations, ids, onError, reorder],
  );
  const disabled = !reorder || ids.length < 2;
  const order = useMemo(() => ({ disabled, move }), [disabled, move]);
  const sensors = useSensors(
    // A short move before the drag starts keeps a click a click.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // A long press starts a drag, so a swipe still scrolls the list.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
  const announcements = useMemo(
    () => pinAnnouncements(conversations),
    [conversations],
  );
  return (
    <DndContext
      accessibility={{ announcements }}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        if (!event.over) return;
        move(String(event.active.id), ids.indexOf(String(event.over.id)));
      }}
      sensors={sensors}
    >
      <SortableContext items={ids}>
        <PinnedOrderContext.Provider value={order}>
          {props.children}
        </PinnedOrderContext.Provider>
      </SortableContext>
      {createPortal(
        <>
          <DragOverlay dropAnimation={null}>
            <PinnedDragPreview conversations={conversations} />
          </DragOverlay>
          <PinDropLine ids={ids} />
        </>,
        document.body,
      )}
    </DndContext>
  );
}

/**
 * Make one pinned row draggable inside `PinnedConversationOrder`. Alt+ArrowUp
 * and Alt+ArrowDown move the row one place without a pointer. Returns nothing
 * when the order is disabled, so the row renders as a plain row.
 */
export function usePinnedRowDrag(
  conversationId: string,
): PinnedRowDrag | undefined {
  const order = useContext(PinnedOrderContext);
  const disabled = !order || order.disabled;
  const sortable = useSortable({ disabled, id: conversationId });
  const { index } = sortable;
  if (disabled) return undefined;
  return {
    dragging: sortable.isDragging,
    listeners: sortable.listeners,
    onKeyDown: (event) => {
      if (!event.altKey) return;
      const offset =
        event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (offset === 0) return;
      event.preventDefault();
      order.move(conversationId, index + offset);
    },
    setNodeRef: sortable.setNodeRef,
  };
}

/** Draw the line where the dragged pin lands, on the edge of the target row. */
function PinDropLine(props: { ids: string[] }) {
  const { active, over } = useDndContext();
  if (!active || !over || over.id === active.id) return null;
  const after =
    props.ids.indexOf(String(active.id)) < props.ids.indexOf(String(over.id));
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none fixed h-0.5 -translate-y-1/2 rounded-full bg-dashboard-accent"
      style={{
        // Inset the line 8px on each side, so it does not touch the row edges.
        left: over.rect.left + 8,
        top: after ? over.rect.top + over.rect.height : over.rect.top,
        width: over.rect.width - 16,
        // Draw above the preview, which DragOverlay puts at 999.
        zIndex: 1000,
      }}
    />
  );
}

function PinnedDragPreview(props: { conversations: Conversation[] }) {
  const { active } = useDndContext();
  const conversation = props.conversations.find(
    (item) => item.id === active?.id,
  );
  if (!conversation) return null;
  return (
    <div className="flex min-w-0 max-w-sm cursor-grabbing items-center gap-2 rounded-lg border border-dashboard-border-strong bg-dashboard-surface-raised px-3 py-1.5 font-sans text-sm leading-snug text-dashboard-text shadow-lg">
      <Pin
        aria-hidden="true"
        className="size-3 shrink-0 text-dashboard-text-muted"
        fill="currentColor"
      />
      <span className="min-w-0 truncate">
        {conversationDisplayTitle(conversation)}
      </span>
    </div>
  );
}

/** Name rows by title, not id, when a screen reader hears a drag. */
function pinAnnouncements(conversations: Conversation[]): Announcements {
  const title = (id: string | number) => {
    const conversation = conversations.find((item) => item.id === id);
    return conversation ? conversationDisplayTitle(conversation) : "pin";
  };
  return {
    onDragCancel: ({ active }) => `Stopped moving ${title(active.id)}.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Moved ${title(active.id)} to the place of ${title(over.id)}.`
        : `Stopped moving ${title(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${title(active.id)} is over ${title(over.id)}.` : undefined,
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
  };
}
