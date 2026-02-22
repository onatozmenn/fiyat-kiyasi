# Fiyat Kıyası — Turkish Grocery Price Comparison

> Compare prices across **A101, BİM, Migros, ŞOK, CarrefourSA, Tarım Kredi & Hakmar** in a single search.

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

## What is this?

Turkish supermarkets price identical products differently — sometimes wildly so. **Fiyat Kıyası** lets you search for any grocery item and instantly see which store sells it cheapest, with unit prices, savings badges, and cross-market grouping.

The core challenge: markets name the same product differently. Migros says *"Coca-Cola Cam 200 Ml"*, A101 says *"Coca Cola Gazlı İçecek Kola Cam 200 ML"*. Our matching algorithm groups them into a single card showing all prices side-by-side.

## Features

- **Real-time price data** from 7 major Turkish supermarket chains
- **Smart product grouping** — matches identical products across markets despite different naming conventions
- **Unit price calculation** — automatically parses weight/volume (kg, g, L, ml) and multipacks (6x200ml)
- **Smart badges** — FIRSAT (deal), POPÜLER (popular), UCUZ (cheapest)
- **Infinite scroll** with skeleton loading
- **Dark theme** responsive UI
- **Server-side caching** with LRU eviction
- **Rate limiting** and input validation

## How the Matching Works

Products go through a 3-layer matching pipeline:

```
┌─────────────────────────────────────────────────┐
│  1. FEATURE EXTRACTION                          │
│     Title → coreName + quantity + variants       │
│     "Coca Cola Gazlı İçecek Kola Cam 200 ML"   │
│     → core: "coca cola kola"                     │
│     → qty: 0.2L                                  │
│     → variants: [cam]                            │
├─────────────────────────────────────────────────┤
│  2. HARD FILTERS (must pass all)                │
│     ✓ Same quantity (200ml = 200ml)              │
│     ✓ Compatible variants (cam ≈ pet ≈ none)    │
│     ✗ Different variants block (zero ≠ light)   │
├─────────────────────────────────────────────────┤
│  3. SIMILARITY SCORING                          │
│     Levenshtein distance    → 0.72              │
│     Token containment       → 0.85              │
│     Best score: max(0.72, 0.85) = 0.85          │
│     Same brand? threshold = 0.40 → ✓ MATCH      │
└─────────────────────────────────────────────────┘
```

**Token Containment** solves the core problem: if *all tokens* of the shorter name exist in the longer name, they're the same product — regardless of how much extra noise one market added.

**Brand-aware thresholds** prevent false positives: same brand gets a lenient 0.40 threshold, unknown brands require 0.55+, and very short names without brands need strict Levenshtein > 0.70.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js (pure `http` module, zero dependencies) |
| **Frontend** | Vanilla JS, CSS |
| **Data Source** | [marketfiyati.org.tr](https://marketfiyati.org.tr) API |
| **Matching** | Levenshtein + Token Containment + Brand Normalization |

No Express. No React. No build step. Just `node server.js`.

## Quick Start

```bash
git clone https://github.com/onatozmenn/fiyat-kiyasi.git
cd fiyat-kiyasi
npm install
npm run dev
```

Open `http://localhost:3001` and search for anything — *süt*, *kola*, *makarna*, *çikolata*.

## Project Structure

```
├── server.js      # API proxy, product grouping, caching, rate limiting
├── app.js         # Frontend logic, rendering, infinite scroll
├── index.html     # Single page with SEO meta tags & JSON-LD
├── styles.css     # Dark theme, responsive design
└── package.json   # Scripts: start, dev (--watch)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | POST | Search products by keyword |
| `/api/product` | POST | Get product by identity |
| `/api/similar` | POST | Find similar products |
| `/api/health` | GET | Health check |

**Search example:**
```bash
curl -X POST http://localhost:3001/api/search \
  -H "Content-Type: application/json" \
  -d '{"keywords": "coca cola", "page": 1}'
```

## Configuration

All tunable constants are at the top of `server.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `CONF_SIMILARITY_THRESHOLD` | 0.55 | Minimum similarity score for grouping |
| `CONF_BADGE_OPPORTUNITY` | 15 | Min savings % for FIRSAT badge |
| `CONF_MARKET_POPULARITY_MIN` | 4 | Min markets for POPÜLER badge |
| `MAX_REQUESTS_PER_MINUTE` | 30 | Rate limit per IP |
| `CACHE_TTL` | 300000 | Cache duration (5 min) |

## License

MIT
