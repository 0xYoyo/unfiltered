/**
 * The design export's ProductResultCard: 3:4 image, brand eyebrow, serif
 * title, mono price, and the match reasons under a hairline. Hover lifts
 * the card and scales the image 1.03 (readme "Hover").
 */
export interface Product {
  image: string;
  brand: string;
  title: string;
  price: string;
  flag?: string;
  matches?: string[];
}

export function ProductResultCard({
  image,
  brand,
  title,
  price,
  flag,
  matches = [],
}: Product) {
  return (
    <div className="unf-product">
      <div className="unf-product__media">
        <img src={image} alt={title} />
        {flag ? <span className="unf-product__flag">{flag}</span> : null}
      </div>
      <div className="unf-product__body">
        <span className="unf-product__brand">{brand}</span>
        <h3 className="unf-product__title">{title}</h3>
        <div className="unf-product__price">
          <span>{price}</span>
        </div>
        {matches.length > 0 ? (
          <div className="unf-product__why">
            {matches.map((match) => (
              <span key={match}>{match}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
