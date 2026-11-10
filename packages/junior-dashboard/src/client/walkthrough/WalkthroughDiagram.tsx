import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { cn } from "../styles";

type Diagram = WalkthroughDocument["content"]["diagram"];
type DiagramView = NonNullable<
  WalkthroughDocument["content"]["chapters"][number]["view"]
>;

const COLUMN_WIDTH = 210;
const ROW_HEIGHT = 104;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 44;
const PAD = 12;

/**
 * Draw the Walkthrough's one diagram. A chapter's view picks what to show, so
 * the reader sees the same picture change from chapter to chapter.
 */
export function WalkthroughDiagram(props: {
  diagram: Diagram;
  view: DiagramView;
}) {
  const { diagram, view } = props;
  const columns = Math.max(...diagram.nodes.map((n) => n.column)) + 1;
  const rows = Math.max(...diagram.nodes.map((n) => n.row)) + 1;
  const width = (columns - 1) * COLUMN_WIDTH + NODE_WIDTH + PAD * 2;
  const height = (rows - 1) * ROW_HEIGHT + NODE_HEIGHT + PAD * 2;
  const shown = new Set(view.show);
  const highlighted = new Set(view.highlight);
  const added = new Set(view.added);
  const broken = new Map(view.broken.map((b) => [b.id, b.label]));
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));

  return (
    <svg
      aria-label="Diagram of the change"
      className="block h-auto w-full max-w-2xl"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <marker
          id="walkthrough-arrow"
          markerHeight="8"
          markerWidth="8"
          orient="auto-start-reverse"
          refX="8"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path className="fill-current" d="M0,0 L8,4 L0,8 z" />
        </marker>
      </defs>
      {diagram.edges.map((edge) => {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (!from || !to) return null;
        const [x1, y1, x2, y2] = edgeLine(from, to);
        const brokenLabel = broken.get(edge.id);
        const label = brokenLabel ?? edge.label;
        return (
          <g
            className={cn(
              "transition-opacity",
              !shown.has(edge.id) && "opacity-15",
              brokenLabel
                ? "text-rose-300"
                : highlighted.has(edge.id)
                  ? "text-dashboard-accent"
                  : "text-dashboard-text-faint",
            )}
            key={edge.id}
          >
            <line
              className="stroke-current"
              markerEnd="url(#walkthrough-arrow)"
              strokeDasharray={
                added.has(edge.id) || brokenLabel ? "5 4" : undefined
              }
              strokeWidth={highlighted.has(edge.id) ? 2 : 1.25}
              x1={x1}
              x2={x2}
              y1={y1}
              y2={y2}
            />
            {label ? (
              <text
                className="fill-current font-sans text-xs"
                // Put labels beside vertical edges and above the others.
                textAnchor={Math.abs(x1 - x2) < 1 ? "start" : "middle"}
                x={Math.abs(x1 - x2) < 1 ? x1 + 8 : (x1 + x2) / 2}
                y={
                  Math.abs(x1 - x2) < 1 ? (y1 + y2) / 2 + 4 : (y1 + y2) / 2 - 8
                }
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
      {diagram.nodes.map((node) => {
        const x = PAD + node.column * COLUMN_WIDTH;
        const y = PAD + node.row * ROW_HEIGHT;
        const isHighlighted = highlighted.has(node.id);
        return (
          <g
            className={cn(
              "transition-opacity",
              !shown.has(node.id) && "opacity-15",
            )}
            key={node.id}
          >
            <rect
              className={cn(
                isHighlighted
                  ? "fill-dashboard-surface-active stroke-dashboard-accent"
                  : "fill-dashboard-surface-raised stroke-dashboard-border-heavy",
              )}
              height={NODE_HEIGHT}
              rx="8"
              strokeDasharray={added.has(node.id) ? "5 4" : undefined}
              strokeWidth={isHighlighted ? 1.5 : 1}
              width={NODE_WIDTH}
              x={x}
              y={y}
            />
            <text
              className="fill-dashboard-text font-sans text-sm"
              dominantBaseline="central"
              textAnchor="middle"
              x={x + NODE_WIDTH / 2}
              y={y + NODE_HEIGHT / 2}
            >
              {node.label}
            </text>
            {added.has(node.id) ? (
              <text
                className="fill-dashboard-accent font-sans text-2xs"
                textAnchor="end"
                x={x + NODE_WIDTH - 8}
                y={y + 13}
              >
                new
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

type GridNode = Diagram["nodes"][number];

/** Center-to-center line, cut at both node borders. */
function edgeLine(
  from: GridNode,
  to: GridNode,
): [number, number, number, number] {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cut = (sign: 1 | -1) => {
    const scale = Math.min(
      dx === 0 ? Infinity : NODE_WIDTH / 2 / Math.abs(dx),
      dy === 0 ? Infinity : NODE_HEIGHT / 2 / Math.abs(dy),
    );
    return { x: sign * dx * scale, y: sign * dy * scale };
  };
  const start = cut(1);
  const end = cut(-1);
  return [
    a.x + start.x,
    a.y + start.y,
    b.x + end.x - Math.sign(dx) * 2,
    b.y + end.y - Math.sign(dy) * 2,
  ];
}

function center(node: GridNode) {
  return {
    x: PAD + node.column * COLUMN_WIDTH + NODE_WIDTH / 2,
    y: PAD + node.row * ROW_HEIGHT + NODE_HEIGHT / 2,
  };
}
