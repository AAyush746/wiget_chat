export function Hero({ hasWidget }: { hasWidget: boolean }) {
  return (
    <section className="hero" id="top">
      <div className="container hero-inner">
        <p className="eyebrow">Field-tested outdoor gear</p>
        <h1>
          Built for the trail,
          <br />
          priced for the workshop.
        </h1>
        <p className="hero-copy">
          Durable packs, vests, and lighting trusted by guides and makers who cannot afford to stop
          mid-job.{' '}
          {hasWidget
            ? 'Questions? Open the chat bubble in the corner — a real person answers.'
            : ''}
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#products">
            Shop the range
          </a>
          <a className="btn btn-ghost" href="#support">
            Talk to support
          </a>
        </div>
      </div>
    </section>
  );
}
