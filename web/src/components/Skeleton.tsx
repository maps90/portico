/**
 * Placeholder that occupies the same space the real cards will, so nothing jumps
 * when the data lands (CLS). Hidden from screen readers, which get the live region
 * on the loaded content instead.
 */
export function PortalSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true">
      <div className="skeleton" style={{ height: 20, width: "70%", marginBottom: 24 }} />

      <section className="card">
        <div className="card-head">
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 15, width: 130, marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 12, width: 220 }} />
          </div>
          <div className="skeleton" style={{ height: 34, width: 116, borderRadius: 10 }} />
        </div>
      </section>

      <section className="card">
        <div className="skeleton" style={{ height: 15, width: 80, marginBottom: 10 }} />
        <div className="skeleton" style={{ height: 12, width: 260 }} />
        {[0, 1, 2].map((row) => (
          <div key={row} className="skeleton-row" style={{ marginTop: row === 0 ? 16 : 0 }}>
            <div className="skeleton" style={{ height: 36, width: 36, borderRadius: 9 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ height: 13, width: 150, marginBottom: 7 }} />
              <div className="skeleton" style={{ height: 10, width: 90 }} />
            </div>
            <div className="skeleton" style={{ height: 22, width: 84, borderRadius: 999 }} />
            <div className="skeleton" style={{ height: 34, width: 96, borderRadius: 10 }} />
          </div>
        ))}
      </section>
    </div>
  );
}
