/**
 * Occupies the same space the real cards will, so nothing jumps when the data lands
 * (CLS). Hidden from screen readers — they get the loaded content instead.
 */
export function PortalSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true">
      <div className="skeleton mb-6 h-5 w-[70%]" />

      <section className="card">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="skeleton mb-2.5 h-4 w-32" />
            <div className="skeleton h-3 w-56" />
          </div>
          <div className="skeleton h-[34px] w-28 rounded-[10px]" />
        </div>
      </section>

      <section className="card">
        <div className="skeleton mb-2.5 h-4 w-20" />
        <div className="skeleton h-3 w-64" />
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className={`flex items-center gap-3 border-t border-line py-3 ${row === 0 ? "mt-4" : ""}`}
          >
            <div className="skeleton h-9 w-9 rounded-[9px]" />
            <div className="flex-1">
              <div className="skeleton mb-1.5 h-3 w-36" />
              <div className="skeleton h-2.5 w-24" />
            </div>
            <div className="skeleton h-[22px] w-20 rounded-full" />
            <div className="skeleton h-[34px] w-24 rounded-[10px]" />
          </div>
        ))}
      </section>
    </div>
  );
}
