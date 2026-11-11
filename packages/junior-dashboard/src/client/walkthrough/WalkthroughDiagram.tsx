import {
  Graph,
  layout,
  type EdgeLabel,
  type GraphLabel,
  type NodeLabel,
} from "@dagrejs/dagre";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";
import { useMemo } from "react";

import { cn } from "../styles";

type Diagram = WalkthroughDocument["content"]["diagram"];
type DiagramView = NonNullable<
  WalkthroughDocument["content"]["chapters"][number]["view"]
>;

const NODE_WIDTH = 156;
const LINE_HEIGHT = 15;
const NODE_PAD_Y = 12;
/** About how many text-xs characters fit on one line of a node. */
const LINE_CHARS = 21;
const EDGE_LABEL_CHAR_WIDTH = 6;
const MARGIN = 12;

/**
 * Draw one diagram. A chapter's view picks what to show, so the reader sees
 * the same picture change from chapter to chapter. Junior lays it out; the
 * model only names the nodes and edges.
 */
export function WalkthroughDiagram(props: {
  diagram: Diagram;
  view: DiagramView;
}) {
  const { diagram, view } = props;
  const placed = useMemo(() => narrowestLayout(diagram), [diagram]);
  const shown = new Set(view.show);
  const highlighted = new Set(view.highlight);
  const added = new Set(view.added);
  const broken = new Map(view.broken.map((b) => [b.id, b.label]));

  return (
    <svg
      aria-label="Diagram of the change"
      // Natural size, so text stays the size of the page text. A wide
      // diagram shrinks to fit the column.
      className="block h-auto max-w-full"
      role="img"
      viewBox={`0 0 ${placed.width} ${placed.height}`}
      width={placed.width}
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
      {placed.edges.map((edge) => {
        const brokenLabel = broken.get(edge.id);
        const label = brokenLabel ?? edge.label;
        return (
          <g
            className={cn(
              "transition-opacity",
              !shown.has(edge.id) && "opacity-40",
              brokenLabel
                ? "text-rose-300"
                : highlighted.has(edge.id)
                  ? "text-dashboard-accent"
                  : "text-dashboard-text-faint",
            )}
            key={edge.id}
          >
            <path
              className="fill-none stroke-current"
              d={edge.path}
              markerEnd="url(#walkthrough-arrow)"
              strokeDasharray={
                added.has(edge.id) || brokenLabel ? "5 4" : undefined
              }
              strokeWidth={highlighted.has(edge.id) ? 2 : 1.25}
            />
            {label && edge.labelAt ? (
              <text
                className="fill-current font-sans text-2xs"
                dominantBaseline="central"
                textAnchor="middle"
                x={edge.labelAt.x}
                y={edge.labelAt.y}
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
      {placed.nodes.map((node) => {
        const isHighlighted = highlighted.has(node.id);
        const top = node.y - node.height / 2;
        const firstLine = node.y - ((node.lines.length - 1) * LINE_HEIGHT) / 2;
        return (
          <g
            className={cn(
              "transition-opacity",
              !shown.has(node.id) && "opacity-40",
            )}
            key={node.id}
          >
            <rect
              className={cn(
                isHighlighted
                  ? "fill-dashboard-surface-active stroke-dashboard-accent"
                  : "fill-dashboard-surface-raised stroke-dashboard-border-heavy",
              )}
              height={node.height}
              rx="8"
              strokeDasharray={added.has(node.id) ? "5 4" : undefined}
              strokeWidth={isHighlighted ? 1.5 : 1}
              width={NODE_WIDTH}
              x={node.x - NODE_WIDTH / 2}
              y={top}
            />
            <text
              className="fill-dashboard-text font-sans text-xs"
              dominantBaseline="central"
              textAnchor="middle"
            >
              {node.lines.map((line, index) => (
                <tspan
                  key={index}
                  x={node.x}
                  y={firstLine + index * LINE_HEIGHT}
                >
                  {line}
                </tspan>
              ))}
            </text>
            {added.has(node.id) ? (
              <text
                className="fill-dashboard-accent font-sans text-2xs"
                textAnchor="end"
                x={node.x + NODE_WIDTH / 2 - 6}
                y={top + 11}
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

type PlacedDiagram = {
  width: number;
  height: number;
  nodes: {
    id: string;
    lines: string[];
    x: number;
    y: number;
    height: number;
  }[];
  edges: {
    id: string;
    label?: string;
    path: string;
    labelAt?: { x: number; y: number };
  }[];
};

/**
 * The diagram sits in a narrow column and shrinks to fit it. A chain is
 * narrow top to bottom, and a fan of callers is narrow left to right, so
 * use the narrower layout.
 */
function narrowestLayout(diagram: Diagram): PlacedDiagram {
  const down = placeDiagram(diagram, "TB");
  const across = placeDiagram(diagram, "LR");
  return across.width < down.width ? across : down;
}

/** Lay the diagram out with dagre. */
function placeDiagram(diagram: Diagram, rankdir: "TB" | "LR"): PlacedDiagram {
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
    multigraph: true,
  });
  graph.setGraph({
    rankdir,
    nodesep: 24,
    ranksep: 36,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const lines = new Map(
    diagram.nodes.map((node) => [node.id, wrapLabel(node.label)]),
  );
  for (const node of diagram.nodes) {
    const count = lines.get(node.id)?.length ?? 1;
    graph.setNode(node.id, {
      width: NODE_WIDTH,
      height: count * LINE_HEIGHT + NODE_PAD_Y * 2,
    });
  }
  for (const edge of diagram.edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    graph.setEdge(
      edge.from,
      edge.to,
      edge.label
        ? {
            width: edge.label.length * EDGE_LABEL_CHAR_WIDTH,
            height: LINE_HEIGHT,
            labelpos: "c",
          }
        : {},
      edge.id,
    );
  }
  layout(graph);

  const nodes = diagram.nodes.map((node) => {
    const placed = graph.node(node.id);
    return {
      id: node.id,
      lines: lines.get(node.id) ?? [node.label],
      x: placed.x ?? 0,
      y: placed.y ?? 0,
      height: placed.height,
    };
  });
  const edges = diagram.edges.flatMap((edge) => {
    const placed = graph.edge({ v: edge.from, w: edge.to, name: edge.id });
    const points = placed?.points ?? [];
    if (points.length < 2) return [];
    return [
      {
        id: edge.id,
        label: edge.label,
        path: points
          .map((p, index) => `${index ? "L" : "M"}${p.x},${p.y}`)
          .join(" "),
        labelAt:
          placed?.x === undefined || placed.y === undefined
            ? undefined
            : { x: placed.x, y: placed.y },
      },
    ];
  });
  const size = graph.graph();
  return {
    width: size.width ?? NODE_WIDTH,
    height: size.height ?? LINE_HEIGHT,
    nodes,
    edges,
  };
}

/** Break a label into lines at spaces. A word that is too long gets cut. */
function wrapLabel(label: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= LINE_CHARS) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (line.length > LINE_CHARS) {
      lines.push(line.slice(0, LINE_CHARS));
      line = line.slice(LINE_CHARS);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [label];
}
