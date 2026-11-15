import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AriaRole,
  type ReactNode,
} from "react";

import { cn } from "../styles";

type AnimatedItem<T> = {
  item: T;
  key: string;
  state: "entering" | "present" | "exiting";
};

/** Keep added and removed list items mounted long enough for standard UI motion. */
export function AnimatedList<T>(props: {
  ariaLabel?: string;
  className?: string;
  durationMs?: number;
  empty?: ReactNode;
  getKey(item: T): string;
  items: T[];
  renderItem(item: T): ReactNode;
  role?: AriaRole;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const durationMs = reducedMotion ? 0 : (props.durationMs ?? 180);
  const [animatedItems, setAnimatedItems] = useState<AnimatedItem<T>[]>(() =>
    props.items.map((item) => ({
      item,
      key: props.getKey(item),
      state: "present",
    })),
  );
  const hasPresentedItems = useRef(props.items.length > 0);
  const exiting = animatedItems.some((item) => item.state === "exiting");
  const removeAnimatedItem = useCallback((key: string) => {
    setAnimatedItems((current) => current.filter((item) => item.key !== key));
  }, []);

  useLayoutEffect(() => {
    setAnimatedItems((current) =>
      mergeAnimatedItems(
        current,
        props.items,
        props.getKey,
        hasPresentedItems.current,
      ),
    );
    if (props.items.length > 0) hasPresentedItems.current = true;
  }, [props.getKey, props.items]);

  useEffect(() => {
    if (!animatedItems.some((item) => item.state === "entering")) return;
    if (reducedMotion) {
      setAnimatedItems((current) => markEnteredItemsPresent(current));
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setAnimatedItems((current) => markEnteredItemsPresent(current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [animatedItems, reducedMotion]);

  return (
    <div
      aria-label={animatedItems.length > 0 ? props.ariaLabel : undefined}
      className={cn(props.className, exiting && "pointer-events-none")}
      role={animatedItems.length > 0 ? props.role : undefined}
    >
      {animatedItems.length > 0
        ? animatedItems.map((animatedItem) => (
            <AnimatedListRow
              animatedItem={animatedItem}
              durationMs={durationMs}
              key={animatedItem.key}
              onExited={removeAnimatedItem}
              renderItem={props.renderItem}
            />
          ))
        : props.empty}
    </div>
  );
}

function mergeAnimatedItems<T>(
  current: AnimatedItem<T>[],
  items: T[],
  getKey: (item: T) => string,
  animateNewItems: boolean,
): AnimatedItem<T>[] {
  const currentByKey = new Map(current.map((item) => [item.key, item]));
  const nextKeys = new Set(items.map(getKey));
  const next: AnimatedItem<T>[] = items.map((item) => {
    const key = getKey(item);
    const previous = currentByKey.get(key);
    return {
      item,
      key,
      state:
        previous?.state === "exiting"
          ? "entering"
          : (previous?.state ?? (animateNewItems ? "entering" : "present")),
    } satisfies AnimatedItem<T>;
  });

  current.forEach((item, index) => {
    if (nextKeys.has(item.key)) return;
    next.splice(Math.min(index, next.length), 0, {
      ...item,
      state: "exiting",
    });
  });
  return next;
}

function AnimatedListRow<T>(props: {
  animatedItem: AnimatedItem<T>;
  durationMs: number;
  onExited(key: string): void;
  renderItem(item: T): ReactNode;
}) {
  const { animatedItem, durationMs, onExited } = props;
  useEffect(() => {
    if (animatedItem.state !== "exiting") return;
    const timeout = window.setTimeout(
      () => onExited(animatedItem.key),
      durationMs,
    );
    return () => window.clearTimeout(timeout);
  }, [animatedItem.key, animatedItem.state, durationMs, onExited]);

  return (
    <div
      aria-hidden={animatedItem.state === "exiting" ? true : undefined}
      className={cn(
        "grid min-w-0 origin-center transition-[grid-template-rows,opacity,transform] motion-reduce:transition-none",
        animatedItem.state === "present"
          ? "grid-rows-[1fr] translate-x-0 scale-100 opacity-100"
          : "pointer-events-none grid-rows-[0fr] translate-x-2 scale-[0.98] opacity-0",
      )}
      data-presence={animatedItem.state}
      inert={animatedItem.state === "exiting" ? true : undefined}
      style={{
        transitionDuration: `${props.durationMs}ms`,
        transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      }}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        {props.renderItem(animatedItem.item)}
      </div>
    </div>
  );
}

function markEnteredItemsPresent<T>(
  items: AnimatedItem<T>[],
): AnimatedItem<T>[] {
  return items.map((item) =>
    item.state === "entering" ? { ...item, state: "present" } : item,
  );
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}
