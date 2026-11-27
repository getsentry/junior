import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useDocumentTitleCount } from "../documentTitle";

// The same image the server sends as `/favicon.ico`. The badge draws on this
// copy because headless Chromium blocks page reads of `/favicon.ico`.
import faviconUrl from "../../assets/junior-favicon.png";

const TAB_ICON_COUNT_STORAGE_KEY = "junior:inbox:tab-icon-count";
/** Canvas size. Browsers scale it down, so a large canvas stays sharp. */
const ICON_SIZE = 64;
// Badge sizes as fractions of the icon. The one-digit circle is the largest
// that stays clear of Junior's eye. The wider `9+` pill is a little lower and
// touches the top edge of the eye, which keeps its digits as large.
const BADGE_CIRCLE = 0.48;
const BADGE_PILL = 0.44;
const BADGE_PILL_WIDTH = 0.66;

/**
 * Edit the browser-only choice to show the Inbox count in the tab title and
 * on the tab icon. On by default, so people opt out. The key predates the
 * title part, so an earlier opt-out still holds.
 */
export function useInboxTabCountSetting() {
  return useLocalStorage<boolean>(TAB_ICON_COUNT_STORAGE_KEY, true);
}

/**
 * Show the Inbox count in the tab title and on the tab icon, unless this
 * browser turned it off.
 */
export function useInboxTabCount(count: number | undefined): void {
  const [enabled] = useInboxTabCountSetting();
  const shown = enabled ? count : undefined;
  useDocumentTitleCount(shown);
  useInboxTabIcon(shown);
}

/**
 * Badge the top-left corner of the browser tab icon with the Inbox count,
 * in the theme's accent. Above 9 it shows `9+`. At zero the original icon
 * comes back.
 */
function useInboxTabIcon(count: number | undefined): void {
  // The shell's icon, read before this hook changes it.
  const [original] = useState(
    () => iconLink()?.getAttribute("href") ?? undefined,
  );
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const label = !count ? undefined : count > 9 ? "9+" : String(count);

  useEffect(() => {
    const link = iconLink();
    if (!link || !original) return;
    if (!label) {
      setIconHref(link, original);
      return;
    }
    let current = true;
    drawBadgedIcon(
      window.__JUNIOR_DASHBOARD_ICONS__?.faviconUrl ?? faviconUrl,
      label,
    ).then(
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
  return document.documentElement.dataset["theme"];
}

async function drawBadgedIcon(src: string, label: string): Promise<string> {
  const image = new Image();
  // A host favicon on another origin needs CORS for the canvas to read it.
  image.crossOrigin = "anonymous";
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
  // The badge sits in the top-left corner, as large as it fits, so the count
  // stays readable at tab sizes.
  const height = ICON_SIZE * (label.length > 1 ? BADGE_PILL : BADGE_CIRCLE);
  const width = label.length > 1 ? ICON_SIZE * BADGE_PILL_WIDTH : height;
  context.beginPath();
  context.roundRect(0, 0, width, height, height / 2);
  context.fillStyle = fill;
  context.fill();

  // The largest heavy count that fits inside the badge's rounded ends.
  const family = getComputedStyle(document.body).fontFamily;
  const maxWidth = width - height * 0.3;
  let size = height * 0.9;
  context.font = `800 ${size}px ${family}`;
  const labelWidth = context.measureText(label).width;
  if (labelWidth > maxWidth) {
    size *= maxWidth / labelWidth;
    context.font = `800 ${size}px ${family}`;
  }
  // Center the drawn glyphs, not the font's line box.
  const glyphs = context.measureText(label);
  context.fillStyle = ink;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(
    label,
    width / 2,
    (height +
      glyphs.actualBoundingBoxAscent -
      glyphs.actualBoundingBoxDescent) /
      2,
  );
  return canvas.toDataURL("image/png");
}
