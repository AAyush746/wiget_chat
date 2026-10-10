import { products } from '../data/products';

export function ProductGrid() {
  return (
    <section className="section" id="products">
      <div className="container">
        <h2 className="section-title">The collection</h2>
        <p className="section-lead">
          A small range, deliberately made. Each piece is warranted for life.
        </p>
        <div className="product-grid">
          {products.map((product) => (
            <article className="product-card" key={product.id}>
              <div
                className="product-swatch"
                style={{ background: product.swatch }}
                role="img"
                aria-label={`${product.name} colourway`}
              >
                {product.badge && <span className="product-badge">{product.badge}</span>}
              </div>
              <div className="product-body">
                <h3>{product.name}</h3>
                <p>{product.tagline}</p>
                <div className="product-footer">
                  <span className="product-price">${product.price}</span>
                  <a className="btn btn-small" href="#support">
                    Ask about it
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
