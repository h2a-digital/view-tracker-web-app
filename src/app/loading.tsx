export default function Loading() {
  return (
    <main className="workspace-loading" aria-busy="true" aria-label="Loading workspace">
      <div className="skeleton skeleton-line" />
      <div className="loading-card-grid">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="card skeleton loading-card" />
        ))}
      </div>
      <p role="status">Loading your workspace…</p>
    </main>
  );
}
