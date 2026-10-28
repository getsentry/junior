import { useLayoutEffect, useRef, useState } from "react";
import { createActivityChartLayout } from "./ActivityChart";

/** Keep chart height and label spacing fixed as its container width changes. */
export function useChartLayout(height: number, left = 64) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  return {
    ref,
    layout: createActivityChartLayout(height, {
      width,
      left,
      top: 18,
      bottom: 28,
    }),
  };
}
