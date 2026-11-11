import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useState, useSyncExternalStore } from "react";

// The same image the server sends as `/favicon.ico`. The badge draws on this
// copy because headless Chromium blocks page reads of `/favicon.ico`.
import faviconUrl from "../../assets/junior-favicon.png";

const TAB_ICON_COUNT_STORAGE_KEY = "junior:inbox:tab-icon-count";
/** Canvas size. Browsers scale it down, so a large canvas stays sharp. */
const ICON_SIZE = 64;

/**
 * Edit the browser-only choice to show the Inbox count on the tab icon. On
 * by default, so people opt out. The tab title shows the count either way.
 */
export function useInboxTabIconCount() {
  return useLocalStorage<boolean>(TAB_ICON_COUNT_STORAGE_KEY, true);
}

/**
 * Badge the browser tab icon with the Inbox count, over Junior's icon in the
 * theme's accent. Above 9 it shows `9+`. At zero, or with the choice off,
 * the original icon comes back.
 */
export function useInboxTabIcon(count: number | undefined): void {
  const [enabled] = useInboxTabIconCount();
  // The shell's icon, read before this hook changes it.
  const [original] = useState(
    () => iconLink()?.getAttribute("href") ?? undefined,
  );
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const label =
    !enabled || !count ? undefined : count > 9 ? "9+" : String(count);

  useEffect(() => {
    const link = iconLink();
    if (!link || !original) return;
    if (!label) {
      setIconHref(link, original);
      return;
    }
    let current = true;
    drawBadgedIcon(faviconUrl, label).then(
      (href) => {
        if (current) setIconHref(link, href);
      },
      // The icon did not load, so the tab keeps the icon it has.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [label, original, theme]);
}

function iconLink() {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

// Change the icon only when it differs: each change can flash the tab.
function setIconHref(link: HTMLLinkElement, href: string) {
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme"],
    attributes: true,
  });
  return () => observer.disconnect();
}

function readTheme() {
  return document.documentElement.dataset.theme;
}

async function drawBadgedIcon(src: string, label: string): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);

  const tokens = getComputedStyle(document.documentElement);
  const fill = tokens.getPropertyValue("--color-dashboard-accent").trim();
  const ink = tokens.getPropertyValue("--color-dashboard-ink").trim();
  const height = ICON_SIZE * 0.6;
  const width = label.length > 1 ? ICON_SIZE * 0.84 : height;
  const x = ICON_SIZE - width;
  const y = ICON_SIZE - height;
  context.beginPath();
  context.roundRect(x, y, width, height, height / 2);
  context.fillStyle = fill;
  context.fill();
  // An ink ring keeps the badge apart from the icon below it.
  context.lineWidth = ICON_SIZE * 0.06;
  context.strokeStyle = ink;
  context.stroke();
  context.fillStyle = ink;
  context.font = `700 ${Math.round(height * 0.7)}px ${getComputedStyle(document.body).fontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + width / 2, y + height / 2 + ICON_SIZE * 0.02);
  return canvas.toDataURL("image/png");
}
