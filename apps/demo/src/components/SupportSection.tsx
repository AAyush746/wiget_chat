export function SupportSection({ hasWidget, apiUrl }: { hasWidget: boolean; apiUrl: string }) {
  return (
    <section className="section section-alt" id="support">
      <div className="container support-grid">
        <div>
          <h2 className="section-title">Support that ships</h2>
          <p className="section-lead">
            Staff respond within the hour on weekdays, 8:00–18:00 UTC. Warranty, sizing, and
            order-status questions all live here.
          </p>
          <ul className="support-list">
            <li>Replacement warranty on every product</li>
            <li>Free returns within 30 days</li>
            <li>Real humans, no phone trees</li>
          </ul>
        </div>
        <div className="support-card">
          <h3>Live chat</h3>
          {hasWidget ? (
            <p>
              The chat widget is live on this page. Use the bubble in the bottom-right corner to
              start a conversation.
            </p>
          ) : (
            <>
              <p>Configure the embedding so a live chat bubble appears here.</p>
              <ol className="setup-steps">
                <li>
                  Run <code>npm run demo</code> to seed a website and print its{' '}
                  <code>publicKey</code>.
                </li>
                <li>
                  Put that key in the repo-root <code>.env</code> as{' '}
                  <code>VITE_DEMO_WEBSITE_KEY</code>.
                </li>
                <li>
                  Restart this app. The API address is <code>{apiUrl}</code>.
                </li>
              </ol>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
