export function Header({ websiteKey }: { websiteKey: string }) {
  return (
    <header className="header">
      <div className="container header-inner">
        <a className="brand" href="#top">
          <span className="brand-mark">NW</span>
          <span className="brand-name">Northward Supplies</span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="#products">Products</a>
          <a href="#support">Support</a>
          {websiteKey && <a href="#contact">Contact</a>}
        </nav>
      </div>
    </header>
  );
}
