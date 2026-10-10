export interface Product {
  id: string;
  name: string;
  tagline: string;
  price: number;
  swatch: string;
  badge?: string;
}

export const products: Product[] = [
  {
    id: 'field-vest',
    name: 'Field Guide Vest',
    tagline: 'Eight pockets, zero bulk. Cut for the trail and the apron.',
    price: 149,
    swatch: 'linear-gradient(135deg, #3f4c45 0%, #5c6b63 60%, #84a194 100%)',
    badge: 'Bestseller',
  },
  {
    id: 'carrier-40',
    name: 'Carrier 40 Pack',
    tagline: 'A 40L carryall that respects your back and the budget.',
    price: 219,
    swatch: 'linear-gradient(135deg, #2c3240 0%, #4a5568 60%, #8fa3b8 100%)',
  },
  {
    id: 'shop-light',
    name: 'Workshop Lantern',
    tagline: 'Recharges from USB-C and throws light fitted for detail work.',
    price: 59,
    swatch: 'linear-gradient(135deg, #b7791f 0%, #d69e2e 60%, #f6e3b0 100%)',
    badge: 'New',
  },
];
