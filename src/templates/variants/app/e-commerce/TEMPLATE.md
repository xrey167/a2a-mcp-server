# E-Commerce — Mobile App Variant

**Pipeline**: app
**Category**: Shopping / Retail
**Complexity**: High

---

## Description

A shopping and retail mobile app with product catalog, cart system, checkout flow, and wishlist. Supports both grid and list product views, image galleries, and category browsing.

---

## Ideal For

- Online stores
- Marketplace apps
- Product catalog apps
- Food delivery apps
- Fashion / clothing apps
- Grocery shopping apps
- Auction / bidding apps

---

## Pre-Configured Features

### Core Features

- Product catalog with grid/list toggle
- Category browsing with nested categories
- Product detail with image gallery
- Shopping cart with quantity management
- Wishlist / favorites system
- Checkout flow (address, payment, confirmation)
- Order history and tracking
- Search with filters and sorting

### UI Components

- Product cards with image, price, rating
- Image carousel / gallery viewer
- Quantity picker with haptic feedback
- Cart badge on tab icon
- Price display with sale/original formatting
- Star rating component
- Filter sheet with multi-select

### Monetization

- Premium membership: $4.99/mo or $39.99/yr
- Benefits: free shipping, early access, exclusive deals
- In-app purchases for premium features

---

## File Structure

```
<project>/
├── app/
│   ├── (tabs)/
│   │   ├── home.tsx          # Featured products, promotions
│   │   ├── browse.tsx        # Category grid
│   │   ├── cart.tsx          # Shopping cart
│   │   └── account.tsx       # Orders, settings
│   ├── product/[id].tsx      # Product detail page
│   ├── category/[slug].tsx   # Category product list
│   └── checkout/
│       └── index.tsx         # Multi-step checkout
├── src/
│   ├── components/
│   │   ├── ProductCard/
│   │   ├── CartItem/
│   │   ├── ImageGallery/
│   │   └── CategoryGrid/
│   ├── store/
│   │   ├── cartStore.ts
│   │   ├── wishlistStore.ts
│   │   └── orderStore.ts
│   ├── services/
│   │   └── api.ts            # Product API client
│   └── types/
│       └── product.ts
```

---

## Default Tech Stack

| Component | Technology |
|---|---|
| Framework | Expo SDK 52 |
| Navigation | Expo Router v4 |
| State | Zustand (cart, wishlist, orders) |
| Images | expo-image |
| Carousel | react-native-reanimated-carousel |
| Storage | expo-sqlite (cart persistence) |
| Haptics | expo-haptics |

---

## Usage

**Prompt Enhancement:**
- Add product catalog with grid/list toggle and pull-to-refresh
- Add shopping cart that persists across app restarts (SQLite)
- Add wishlist with heart icon toggle animation
- Add product detail with swipeable image gallery
- Add category browsing with breadcrumb navigation
- Add checkout flow: cart review → shipping → payment → confirmation
- Add search with debounced input, recent searches, and filters
- Add order history with status tracking
- Use mock product data (10-20 items) with realistic images

**Example:**
- User says: "shoe store app"
- Enhanced to: "A sneaker marketplace with product grid showing shoe images, prices, and brand badges. Features size selector, color variants, 360° image viewer, cart with size/color per item, wishlist, and order tracking. Premium membership for early drops and free shipping."

---

## Quality Checklist

- [ ] Product grid renders with images and prices
- [ ] Cart persists across app restarts
- [ ] Adding/removing items updates cart badge
- [ ] Quantity picker prevents negative values
- [ ] Product detail shows all images in gallery
- [ ] Category navigation works with back button
- [ ] Checkout flow completes without errors
- [ ] Wishlist toggle animates on tap
- [ ] Search returns filtered results
- [ ] Empty states shown for empty cart/wishlist/orders

---

## Customization Points

- Product data model in types/product.ts
- Cart logic in store/cartStore.ts
- Product card layout in components/ProductCard/
- Checkout steps in checkout/index.tsx
- Category structure in category/[slug].tsx
- API endpoints in services/api.ts
