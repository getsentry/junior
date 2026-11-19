import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { conversationAttachmentUrl } from "../conversations/TranscriptAttachment";
import { cn } from "../styles";
import { AskKindIcon } from "./askKind";
import type { AskPill } from "./inboxAsks";
import { WorkLine, type WorkLineObject } from "./InboxLinkedWork";
import {
  FEED_MEDIA_LIMIT,
  isImageMedia,
  useConversationImages,
  type ConversationMedia,
} from "./useConversationImages";

/** Linked work with a preview image, such as a PR's first description image. */
export type ImageWork = WorkLineObject & { imageUrl: string; url: string };

// One fixed box per image, so nothing moves while images load. The image
// keeps its aspect inside it.
const BOX_WIDTH = 256;
const BOX_HEIGHT = 160;
const FRAME =
  "h-40 shrink-0 overflow-hidden rounded-lg border border-dashboard-border bg-dashboard-fill-faint";
const BOX = cn(FRAME, "block w-64");
// How near an image comes to the strip's edge before it loads.
const NEAR = "0px 320px";

// Whether `target` has come near the visible part of `root`. Native lazy
// loading decides by distance to the page viewport, so it loads images far
// along a horizontal strip too.
function useNear(
  target: RefObject<HTMLElement | null>,
  root: RefObject<HTMLElement | null>,
): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !target.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: root.current, rootMargin: NEAR },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [near, root, target]);
  return near;
}

function LazyImage(props: {
  alt: string;
  onError(): void;
  root: RefObject<HTMLElement | null>;
  src: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const near = useNear(box, props.root);
  return (
    <span className="block size-full" ref={box}>
      {near ? (
        <img
          alt={props.alt}
          className="size-full object-contain"
          decoding="async"
          height={BOX_HEIGHT}
          loading="lazy"
          onError={props.onError}
          src={props.src}
          width={BOX_WIDTH}
        />
      ) : null}
    </span>
  );
}

/** What an ask icon on a PR card expands: the row's asks, as a pill does. */
type AskToggle = { controls: string; expanded: boolean; onToggle(): void };

// A PR card: its image, then its line. An ask on it shows as its kind icon.
function WorkTile(props: {
  ask: AskPill | undefined;
  askToggle: AskToggle;
  main: string | undefined;
  root: RefObject<HTMLElement | null>;
  work: ImageWork;
}) {
  const { ask, work } = props;
  // A preview that fails to load leaves no empty box or alt text.
  const [failed, setFailed] = useState(false);
  return (
    <div className="grid w-64 shrink-0 snap-start gap-1" data-image-tile="work">
      {failed ? null : (
        <a className={BOX} href={work.url} rel="noreferrer" target="_blank">
          <LazyImage
            alt={`Preview of ${work.title}`}
            onError={() => setFailed(true)}
            root={props.root}
            src={work.imageUrl}
          />
        </a>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        {ask ? (
          // The card takes the ask's pill, so it takes the pill's job too.
          <button
            aria-controls={props.askToggle.controls}
            aria-expanded={props.askToggle.expanded}
            aria-label={ask.name}
            className="flex shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
            data-ask-pill={ask.kind}
            onClick={props.askToggle.onToggle}
            title={ask.name}
            type="button"
          >
            <AskKindIcon kind={ask.kind} />
          </button>
        ) : null}
        <WorkLine href={work.url} main={props.main} work={work} />
      </span>
    </div>
  );
}

function MediaTile(props: {
  conversationId: string;
  media: ConversationMedia;
  root: RefObject<HTMLElement | null>;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const href = conversationAttachmentUrl(props.conversationId, props.media.id);
  return (
    <a
      className={cn(BOX, "snap-start")}
      data-image-tile="media"
      href={href}
      rel="noreferrer"
      target="_blank"
      title={props.media.filename}
    >
      <LazyImage
        alt={props.media.filename}
        onError={() => setFailed(true)}
        root={props.root}
        src={href}
      />
    </a>
  );
}

// Which ends of the strip have more images past them.
function useScrollEdges(
  scroller: RefObject<HTMLElement | null>,
  count: number,
) {
  const [edges, setEdges] = useState({ end: false, start: false });
  const update = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end =
      element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges((current) =>
      current.start === start && current.end === end ? current : { end, start },
    );
  }, [scroller]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [count, scroller, update]);
  return { edges, update };
}

function fadeMask(edges: { end: boolean; start: boolean }) {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start ? "transparent, black 2rem" : "black";
  const end = edges.end ? "black calc(100% - 2rem), transparent" : "black";
  return `linear-gradient(to right, ${start}, ${end})`;
}

function ScrollButton(props: {
  direction: -1 | 1;
  onClick(): void;
  shown: boolean;
}) {
  const Icon = props.direction < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      aria-label={props.direction < 0 ? "Earlier images" : "Later images"}
      className={cn(
        "absolute top-[4.25rem] hidden size-7 items-center justify-center rounded-full border border-dashboard-border bg-dashboard-surface-panel text-dashboard-text-muted shadow-sm transition-opacity hover:text-dashboard-text focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-dashboard-focus",
        // Mouse users get buttons; touch and trackpads scroll the strip.
        props.shown &&
          "[@media(hover:hover)_and_(pointer:fine)]:flex [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/strip:opacity-100",
        props.direction < 0 ? "left-1" : "right-1",
      )}
      onClick={props.onClick}
      tabIndex={-1}
      type="button"
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

/**
 * Every image of a Conversation in one row under its title, at preview
 * size: PR images first, each with its line, then the Conversation's
 * images, newest first. The row scrolls sideways and loads each image as
 * it comes near. The feed sends only the newest files, so the strip reads
 * older images from the Conversation's history as the person scrolls near
 * its end, one batch at a time, until the history runs out.
 */
export function InboxImageStrip(props: {
  asks: ReadonlyMap<string, AskPill>;
  /** Lets each ask icon expand the row, as the pill it replaces does. */
  askToggle: AskToggle;
  conversationId: string;
  main: string | undefined;
  media: ConversationMedia[];
  work: ImageWork[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLSpanElement>(null);
  const mayHaveMore = props.media.length >= FEED_MEDIA_LIMIT;
  const [wantOlder, setWantOlder] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const older = useConversationImages(
    props.conversationId,
    mayHaveMore && wantOlder,
  );
  const seen = new Set<string>();
  const images = [...props.media.filter(isImageMedia), ...older.images].filter(
    (media) => {
      const key = `${media.id}\n${media.filename}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  const canLoad = mayHaveMore && !older.done;
  const { edges, update } = useScrollEdges(
    scroller,
    props.work.length + images.length + Number(canLoad),
  );
  const loadOlder = useRef(older.loadMore);
  loadOlder.current = older.loadMore;
  // Near the end, after the person scrolls, read the next older page. A
  // strip that never scrolls reads nothing. Each batch gets a new observer:
  // a batch with no new images leaves the end in view, and only a new
  // observer reports that again.
  useEffect(() => {
    if (!canLoad || !scrolled || !end.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setWantOlder(true);
        loadOlder.current();
      },
      { root: scroller.current, rootMargin: NEAR },
    );
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [canLoad, older.loading, older.pages, scrolled]);
  const scrollBy = (direction: -1 | 1) => {
    const element = scroller.current;
    if (!element) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    element.scrollBy({
      behavior: reduced ? "auto" : "smooth",
      left: direction * element.clientWidth * 0.8,
    });
  };
  if (props.work.length === 0 && images.length === 0) return null;
  return (
    <div className="group/strip relative min-w-0">
      <div
        aria-label="Images"
        className="flex snap-x snap-proximity items-start gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-dashboard-focus"
        data-image-strip=""
        onScroll={() => {
          setScrolled(true);
          update();
        }}
        ref={scroller}
        role="group"
        style={{ maskImage: fadeMask(edges) }}
        // Arrow keys scroll it once it has focus.
        tabIndex={0}
      >
        {props.work.map((work) => (
          <WorkTile
            ask={props.asks.get(work.url)}
            askToggle={props.askToggle}
            key={work.key}
            main={props.main}
            root={scroller}
            work={work}
          />
        ))}
        {images.map((media) => (
          <MediaTile
            conversationId={props.conversationId}
            key={`${media.id}\n${media.filename}`}
            media={media}
            root={scroller}
          />
        ))}
        {/* A batch on its way shows as one placeholder tile of the same
            size, so nothing moves when it lands. */}
        {canLoad && older.loading ? (
          <span
            aria-label="Loading images"
            className={cn(
              FRAME,
              "w-64 animate-pulse bg-dashboard-fill-hover motion-reduce:animate-none",
            )}
            data-image-skeleton=""
            role="status"
          />
        ) : null}
        <span aria-hidden="true" className="w-px shrink-0" ref={end} />
      </div>
      <ScrollButton
        direction={-1}
        onClick={() => scrollBy(-1)}
        shown={edges.start}
      />
      <ScrollButton
        direction={1}
        onClick={() => scrollBy(1)}
        shown={edges.end}
      />
    </div>
  );
}
