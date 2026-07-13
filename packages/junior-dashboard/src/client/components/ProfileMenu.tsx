import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { peoplePath } from "../format";
import { cn } from "../styles";
import type { Identity } from "../types";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
};

function initials(name: string | null | undefined, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  return email.slice(0, 1).toUpperCase();
}

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({ identity, onSignOut }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-controls="profile-popover"
        aria-expanded={open}
        aria-label={`Open profile menu for ${name}`}
        className={cn(
          "flex h-9 cursor-pointer items-center gap-2 rounded border border-white/15 bg-[#0b0b0b] px-1.5 text-[#d6d6d6] transition-colors hover:border-white/30 hover:bg-[#151515] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70",
          open && "border-white/30 bg-[#151515] text-white",
        )}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-[#beaaff] text-[0.68rem] font-bold tracking-wide text-black"
        >
          {initials(identity.user.name, email)}
        </span>
        <span className="max-w-32 truncate text-[0.8rem] font-semibold max-sm:hidden">
          {identity.user.name?.trim() || "My profile"}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("transition-transform", open && "rotate-180")}
          size={14}
          strokeWidth={2}
        />
      </button>

      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+0.5rem)] z-20 w-64 rounded-lg border border-white/15 bg-[#0b0b0b] p-1.5 shadow-2xl shadow-black/60"
          id="profile-popover"
        >
          <div className="border-b border-white/10 px-2.5 py-2.5">
            <p className="m-0 truncate text-sm font-semibold text-white">
              {name}
            </p>
            {name !== email ? (
              <p className="mt-1 mb-0 truncate text-xs text-[#888]">{email}</p>
            ) : null}
          </div>
          <Link
            className="mt-1 flex items-center gap-2.5 px-2.5 py-2 text-[0.82rem] font-semibold text-[#d6d6d6] no-underline transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none"
            onClick={() => setOpen(false)}
            to={peoplePath(email)}
          >
            <UserRound aria-hidden="true" size={16} strokeWidth={2} />
            My profile
          </Link>
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2.5 py-2 text-left text-[0.82rem] font-semibold text-[#d6d6d6] transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            type="button"
          >
            <LogOut aria-hidden="true" size={16} strokeWidth={2} />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}
