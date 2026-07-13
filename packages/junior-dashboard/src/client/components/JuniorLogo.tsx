/** Render Junior's official avatar treatment used by the dashboard shell. */
export function JuniorLogo() {
  return (
    <div className="relative grid size-10 shrink-0 select-none place-items-center overflow-visible">
      <img
        alt=""
        className="relative size-11 max-w-none -translate-y-0.5 object-contain opacity-90 drop-shadow-[0_0_7px_rgba(255,255,255,0.16)]"
        draggable={false}
        src="/_junior/dashboard/avatar.png"
      />
    </div>
  );
}
