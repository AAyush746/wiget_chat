export function SetupNotice() {
  return (
    <div className="setup-notice" role="status">
      <div className="container">
        <strong>Demo storefront is not configured yet.</strong>
        <span>
          Set <code>VITE_DEMO_WEBSITE_KEY</code> in the repo-root <code>.env</code> to the{' '}
          <code>publicKey</code> printed by <code>npm run demo</code>. Without it the chat widget
          stays unmounted. See <code>apps/demo/.env.example</code>.
        </span>
      </div>
    </div>
  );
}
