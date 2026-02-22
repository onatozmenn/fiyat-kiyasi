// Fiyat Kıyası API Server
// Architecture: REST API (Logic Centralized)
// Features: Rate Limit, CORS, Cache, Smart Grouping, Static File Serving,
//           Input Validation, Structured Logging, Health Check, Graceful Shutdown

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

// --- 1. CONFIG & SECURITY ---

const TRUST_PROXY = process.env.TRUST_PROXY === 'true'; // Enable only behind a reverse proxy
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const MAX_BODY_SIZE = 10 * 1024; // 10KB
const MAX_KEYWORD_LENGTH = 200;
const MAX_PAGE_SIZE = 100;
const ipRequestCounts = new Map();

// CORS: Localhost + Production + Environment override
const ALLOWED_ORIGINS = [
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080',
    'https://fiyatkiyasla.com',
    'https://www.fiyatkiyasla.com',
    ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [])
];

// Cache
const CACHE_TTL = 60 * 1000;
const MAX_CACHE_SIZE = 500;
const requestCache = new Map();

// Static file MIME types
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const STATIC_ROOT = __dirname;

// --- STRUCTURED LOGGING ---

function log(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta
    };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

// Cleanup timers
const cleanupTimers = [];
cleanupTimers.push(setInterval(() => ipRequestCounts.clear(), RATE_LIMIT_WINDOW));
cleanupTimers.push(setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [k, v] of requestCache.entries()) {
        if (now > v.expiry) { requestCache.delete(k); cleaned++; }
    }
    if (cleaned > 0) log('info', 'Cache cleanup', { removed: cleaned, remaining: requestCache.size });
}, 300000));

// --- 2. BUSINESS LOGIC (Moved from Frontend) ---

const STRICT_VARIANTS = [
    // Diet / Sugar
    'light', 'zero', 'şekersiz', 'diyet',
    // Fat content
    'laktozsuz', 'tam yağlı', 'yarım yağlı', 'az yağlı',
    // Flavor
    'sade', 'kakaolu', 'çilekli', 'muzlu', 'fındıklı', 'fıstıklı',
    'meyveli', 'sütlü', 'bitter', 'vişneli', 'şeftalili', 'kayısılı',
    // Organic / Health
    'organik', 'glutensiz',
    // Spice
    'acılı', 'acısız', 'baharatlı',
    // Tea types
    'rize', 'tiryaki', 'filiz',
    // Color / Type
    'siyah', 'yeşil', 'beyaz', 'kırmızı',
    // Quality tier
    'ekstra', 'gold', 'klasik', 'premium',
    // Container / Packaging
    'cam', 'pet', 'teneke', 'kutu'
];

// Noise words: generic descriptors that markets add inconsistently.
// These inflate token count and hurt similarity for no informational value.
const NOISE_WORDS = new Set([
    'gazlı', 'gazsız', 'içecek', 'içeceği', 'ürün', 'ürünü',
    'gıda', 'marka', 'markalı', 'no', 'the', 've', 'ile',
    'aromalı', 'aroması', 'çeşnili', 'tatlandırıcılı',
    'doğal', 'naturel', 'taze', 'katkısız'
]);

// Configuration Constants
const CONF_SIMILARITY_THRESHOLD = 0.55;
const CONF_BADGE_OPPORTUNITY = 15; // en az %15 indirim
const CONF_MARKET_POPULARITY_MIN = 4; // en az 4 markette satılıyorsa popüler

// Levenshtein (Memoized, LRU with key length limit)
const MAX_LEVENSHTEIN_CACHE = 20000;
const MAX_CACHE_KEY_LENGTH = 100;
const levenshteinCache = new Map();
function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const k = a < b ? `${a}|${b}` : `${b}|${a}`;

    // Skip cache for very long keys to prevent memory bloat
    const useCache = k.length <= MAX_CACHE_KEY_LENGTH;

    if (useCache && levenshteinCache.has(k)) {
        // LRU: Move to end (freshen)
        const val = levenshteinCache.get(k);
        levenshteinCache.delete(k);
        levenshteinCache.set(k, val);
        return val;
    }

    if (a.length > b.length) [a, b] = [b, a];
    let row = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let i = 1; i <= b.length; i++) {
        let prev = i;
        for (let j = 1; j <= a.length; j++) {
            const val = b[i - 1] === a[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
            row[j - 1] = prev;
            prev = val;
        }
        row[a.length] = prev;
    }

    // LRU: Enforce Limit
    if (useCache) {
        if (levenshteinCache.size >= MAX_LEVENSHTEIN_CACHE) {
            const oldestKey = levenshteinCache.keys().next().value;
            levenshteinCache.delete(oldestKey);
        }
        levenshteinCache.set(k, row[a.length]);
    }
    return row[a.length];
}

function calculateSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    if ((longer.length - shorter.length) / longer.length > 0.5) return 0;

    const dist = levenshtein(s1, s2);
    return (longer.length - dist) / longer.length;
}

// Brand normalization: "COCA-COLA" and "Coca Cola" → "cocacola"
function normalizeBrand(brand) {
    if (!brand) return '';
    return brand.toLowerCase().replace(/[^a-z0-9ğüşıöç]/g, '').trim();
}

// Token-based similarity: solves the core cross-market naming problem.
// Problem: Migros says "Coca-Cola Cam 200 Ml", A101 says "Coca Cola Gazlı İçecek
// Kola Cam 200 ML". After cleanup coreName: "coca cola" vs "coca cola kola".
// Levenshtein fails (length diff too big). But ALL tokens of the short name
// exist in the long name → they're the same product.
function calculateTokenSimilarity(s1, s2) {
    const tokens1 = s1.split(/\s+/).filter(t => t.length > 1);
    const tokens2 = s2.split(/\s+/).filter(t => t.length > 1);
    if (tokens1.length === 0 || tokens2.length === 0) return 0;

    const shorter = tokens1.length <= tokens2.length ? tokens1 : tokens2;
    const longerArr = tokens1.length <= tokens2.length ? tokens2 : tokens1;
    const longerSet = new Set(longerArr);

    let matches = 0;
    for (const token of shorter) {
        if (longerSet.has(token)) {
            matches++;
        } else {
            // Fuzzy per-token match for minor spelling diffs (e.g. "kola" vs "cola")
            for (const lt of longerSet) {
                if (lt.length > 2 && token.length > 2 && calculateSimilarity(token, lt) > 0.75) {
                    matches++;
                    break;
                }
            }
        }
    }

    if (matches === 0) return 0;

    const containment = matches / shorter.length;
    const lengthRatio = shorter.length / longerArr.length;

    return containment * (0.55 + 0.45 * lengthRatio);
}

function parseQuantity(title) {
    const t = title.toLowerCase();

    // 1. Double Match (Multipack) - e.g. 6 x 200 ml, 6x200ml, 3 * 180 g
    const multiRegex = /(\d+)\s*(?:x|\*|×)\s*(\d+(?:[.,]\d+)?)\s*(kilo|kg|gr|g|litre|lt|l|ml|adt|ad)?/i;
    const multiMatch = t.match(multiRegex);

    if (multiMatch) {
        const count = parseFloat(multiMatch[1]);
        const amount = parseFloat(multiMatch[2].replace(',', '.'));
        const unitStr = multiMatch[3] || '';

        let factor = 1;
        let unit = 'adt';

        if (/kilo|kg/i.test(unitStr)) { unit = 'kg'; factor = 1; }
        else if (/gr|g/i.test(unitStr)) { unit = 'kg'; factor = 0.001; }
        else if (/litre|lt|l/i.test(unitStr) && !/ml/i.test(unitStr)) { unit = 'L'; factor = 1; }
        else if (/ml/i.test(unitStr)) { unit = 'L'; factor = 0.001; }

        if (unit !== 'adt') {
            return { value: count * amount * factor, unit: unit, rawMatch: multiMatch[0] };
        } else {
            // Check title for unit immediately following the multi match
            const outerUnitRegex = /^\s*(kilo|kg|gr|g|litre|lt|l|ml)/i;
            const remaining = t.substring(multiMatch.index + multiMatch[0].length);
            const outerMatch = remaining.match(outerUnitRegex);
            if (outerMatch) {
                const u = outerMatch[1];
                if (/kilo|kg/i.test(u)) { unit = 'kg'; factor = 1; }
                else if (/gr|g/i.test(u)) { unit = 'kg'; factor = 0.001; }
                else if (/litre|lt|l/i.test(u) && !/ml/i.test(u)) { unit = 'L'; factor = 1; }
                else if (/ml/i.test(u)) { unit = 'L'; factor = 0.001; }
                return { value: count * amount * factor, unit: unit, rawMatch: multiMatch[0] + outerMatch[0] };
            }
            return { value: count, unit: 'adt', rawMatch: multiMatch[0] };
        }
    }

    // 2. Single Match
    const patterns = [
        { regex: /(\d+(?:[.,]\d+)?)\s*kilo/, unit: 'kg', factor: 1 },
        { regex: /(\d+(?:[.,]\d+)?)\s*kg/, unit: 'kg', factor: 1 },
        { regex: /(\d+(?:[.,]\d+)?)\s*gr/, unit: 'kg', factor: 0.001 },
        { regex: /(\d+(?:[.,]\d+)?)\s*g\b/, unit: 'kg', factor: 0.001 },
        { regex: /(\d+(?:[.,]\d+)?)\s*litre/, unit: 'L', factor: 1 },
        { regex: /(\d+(?:[.,]\d+)?)\s*lt/, unit: 'L', factor: 1 },
        { regex: /(\d+(?:[.,]\d+)?)\s*l\b/, unit: 'L', factor: 1 },
        { regex: /(\d+(?:[.,]\d+)?)\s*ml/, unit: 'L', factor: 0.001 },
        { regex: /(\d+)\s*['`’]?\s*(?:li|lı|lu|lü)/, unit: 'adt', factor: 1 },
        { regex: /(\d+)\s*(?:adet|ad(?:\.|et)?)\b/, unit: 'adt', factor: 1 }
    ];

    for (const p of patterns) {
        const m = t.match(p.regex);
        if (m) {
            return { value: parseFloat(m[1].replace(',', '.')) * p.factor, unit: p.unit, rawMatch: m[0] };
        }
    }
    return null;
}

// Default variants that can be matched with an empty variant list (Implicitly standard)
const DEFAULT_VARIANTS = ['sade', 'klasik', 'normal', 'standart', 'cam', 'pet', 'teneke', 'kutu'];

function extractProductFeatures(title) {
    let cleanTitle = title.toLowerCase();
    const qty = parseQuantity(cleanTitle);

    const foundVariants = [];
    STRICT_VARIANTS.forEach(v => {
        // Word boundary check to prevent substring false positives
        // e.g. "cam" matching inside "Çamlıca", "gold" inside "Goldaş"
        const regex = new RegExp(`(?:^|\\s|\\b)${v}(?:$|\\s|\\b)`, 'i');
        if (regex.test(cleanTitle)) foundVariants.push(v);
    });
    foundVariants.sort();

    let coreName = cleanTitle;
    if (qty && qty.rawMatch) {
        coreName = coreName.replace(qty.rawMatch, '');
    }

    // Remove found variants from coreName to prevent double-counting
    foundVariants.forEach(v => {
        const regex = new RegExp(`(?:^|\\s)${v}(?:$|\\s)`, 'gi');
        coreName = coreName.replace(regex, ' ');
    });

    // Remove noise words that markets add inconsistently
    coreName = coreName.replace(/[^a-z0-9ğüşıöç ]/g, ' ');
    coreName = coreName.split(/\s+/).filter(w => w.length > 1 && !NOISE_WORDS.has(w)).join(' ').trim();

    return { qty, variants: foundVariants, coreName };
}

// Core matching — takes FULL product objects (not just titles) for brand-aware matching
function areProductsCompatible(p1, p2) {
    const f1 = extractProductFeatures(p1.title);
    const f2 = extractProductFeatures(p2.title);

    // 1. Quantity must match exactly
    if ((f1.qty && !f2.qty) || (!f1.qty && f2.qty)) return false;
    if (f1.qty && f2.qty) {
        if (f1.qty.unit !== f2.qty.unit) return false;
        if (Math.abs(f1.qty.value - f2.qty.value) > 0.001) return false;
    }

    // 2. Variant matching — different variants = different products
    const v1 = new Set(f1.variants);
    const v2 = new Set(f2.variants);
    const diff = new Set([...v1, ...v2].filter(x => !v1.has(x) || !v2.has(x)));
    if (diff.size > 0) {
        const onlyDefaults = [...diff].every(d => DEFAULT_VARIANTS.includes(d));
        if (!onlyDefaults) return false;
    }

    // 3. Multi-signal similarity (Levenshtein + Token Containment)
    const levSim = calculateSimilarity(f1.coreName, f2.coreName);
    const tokenSim = calculateTokenSimilarity(f1.coreName, f2.coreName);
    const bestSim = Math.max(levSim, tokenSim);

    // 4. Brand-aware matching
    const brand1 = normalizeBrand(p1.brand);
    const brand2 = normalizeBrand(p2.brand);
    const sameBrand = brand1.length > 0 && brand2.length > 0 && brand1 === brand2;

    if (sameBrand) {
        // Same brand + same qty + same variants → lenient threshold
        return bestSim > 0.40;
    }

    // 5. Without brand: guard against short-name false positives
    const minTokenCount = Math.min(
        f1.coreName.split(/\s+/).filter(t => t.length > 1).length,
        f2.coreName.split(/\s+/).filter(t => t.length > 1).length
    );
    if (minTokenCount < 2) {
        // Very short names without brand → strict Levenshtein only
        return levSim > 0.70;
    }

    return bestSim > CONF_SIMILARITY_THRESHOLD;
}

// NOTE: groupProducts uses O(n²) compatibility checks.
// For current page sizes (≤100), this is performant (~5ms for 50 products).
// If size grows significantly, consider a Map<normalizedKey, group> approach.
function groupProducts(rawProducts) {
    const groups = [];
    rawProducts.forEach(p => {
        let match = null;
        for (const group of groups) {
            if (areProductsCompatible(p, group)) {
                match = group;
                break;
            }
        }
        if (match) {
            const newDepots = p.productDepotInfoList || [];
            newDepots.forEach(depot => {
                const existingIdx = match.productDepotInfoList.findIndex(d => d.marketAdi === depot.marketAdi);
                if (existingIdx === -1) {
                    // New market — add it
                    match.productDepotInfoList.push(depot);
                } else if (depot.price < match.productDepotInfoList[existingIdx].price) {
                    // Same market but cheaper price — keep the cheaper one
                    match.productDepotInfoList[existingIdx] = depot;
                }
            });
        } else {
            groups.push({ ...p, productDepotInfoList: [...(p.productDepotInfoList || [])] });
        }
    });

    // Sort logic moved to backend too
    groups.sort((a, b) => {
        const countA = a.productDepotInfoList?.length || 0;
        const countB = b.productDepotInfoList?.length || 0;
        if (Math.abs(countA - countB) >= 2) return countB - countA;
        const priceA = Math.min(...(a.productDepotInfoList?.map(d => d.price) || [0]));
        const priceB = Math.min(...(b.productDepotInfoList?.map(d => d.price) || [0]));
        return priceA - priceB;
    });

    // Final Touch: Prepare View Model for Frontend (Server-Side Rendering Logic)
    return groups.map(g => {
        const qty = parseQuantity(g.title);

        // 1. Sort Markets
        const depots = g.productDepotInfoList || [];
        const sortedMarkets = [...depots].sort((a, b) => a.price - b.price);

        // 2. Calculate Prices
        const prices = sortedMarkets.map(d => d.price).filter(x => x > 0);
        const minPrice = prices.length ? prices[0] : 0;
        const maxPrice = prices.length ? Math.max(...prices) : 0; // Prices are sort ascending, so last isn't always max if duplicate logic exists? Best to use Math.max just in case
        let savings = maxPrice > minPrice ? Math.round((maxPrice - minPrice) / maxPrice * 100) : 0;
        // Cap savings at 70% to filter out likely mismatched groupings
        if (savings > 70) savings = 0;

        // 3. Prepare Markets with Unit Prices
        const processedMarkets = sortedMarkets.map(m => {
            let unitPrice = null;
            if (qty && qty.value > 0) {
                unitPrice = (m.price / qty.value).toFixed(2);
            }
            return {
                name: m.marketAdi, // Frontend sadece isme bakacak
                price: m.price,
                unitPrice: unitPrice
            };
        });

        // 4. Determine Smart Badge
        let badge = null;
        if (savings >= CONF_BADGE_OPPORTUNITY && sortedMarkets.length > 1) {
            badge = { text: 'FIRSAT', type: 'opportunity' };
        } else if (sortedMarkets.length >= CONF_MARKET_POPULARITY_MIN) {
            badge = { text: 'POPÜLER', type: 'popular' };
        } else if (savings > 0 && sortedMarkets.length > 1) {
            badge = { text: 'UCUZ', type: 'cheap' };
        }

        return {
            ...g,
            // UI Logic is encapsulated here
            viewModel: {
                minPrice,
                maxPrice,
                savings,
                markets: processedMarkets,
                marketCount: sortedMarkets.length,
                badge: badge,
                unit: qty ? qty.unit : null
            }
        };
    });
}

// --- 3. SERVER HANDLING ---

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        options.timeout = 10000;
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

// Retry wrapper: retries on timeout or 5xx errors
async function makeRequestWithRetry(options, postData = null, maxRetries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await makeRequest({ ...options }, postData);
            if (result.status >= 500 && attempt < maxRetries) {
                log('warn', 'Upstream 5xx, retrying', { status: result.status, attempt: attempt + 1 });
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            return result;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                log('warn', 'Upstream error, retrying', { error: err.message, attempt: attempt + 1 });
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw lastError;
}

// --- 4. STATIC FILE SERVING ---

function serveStaticFile(reqPath, res) {
    // Default to index.html for root
    let filePath = reqPath === '/' ? '/index.html' : reqPath;

    // Path traversal protection
    const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(STATIC_ROOT, safePath);

    // Ensure resolved path is within STATIC_ROOT
    if (!fullPath.startsWith(STATIC_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // SPA fallback: serve index.html for unknown paths
                fs.readFile(path.join(STATIC_ROOT, 'index.html'), (err2, html) => {
                    if (err2) {
                        res.writeHead(404);
                        res.end('Not Found');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                });
                return;
            }
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
        }

        // Cache static assets for 1 hour (except HTML)
        const cacheHeader = ext === '.html'
            ? 'no-cache'
            : 'public, max-age=3600';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': cacheHeader
        });
        res.end(data);
    });
}

// --- 5. HTTP REQUEST HANDLER ---

function getClientIp(req) {
    if (TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                reject(new Error('PAYLOAD_TOO_LARGE'));
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function validateSearchParams(params) {
    const errors = [];

    // Keywords
    let keywords = (params.keywords || '').toString().trim();
    if (keywords.length === 0) errors.push('keywords is required');
    if (keywords.length > MAX_KEYWORD_LENGTH) {
        keywords = keywords.substring(0, MAX_KEYWORD_LENGTH);
    }

    // Pages
    let pages = parseInt(params.pages, 10);
    if (isNaN(pages) || pages < 0) pages = 0;

    // Size
    let size = parseInt(params.size, 10);
    if (isNaN(size) || size < 1) size = 24;
    if (size > MAX_PAGE_SIZE) size = MAX_PAGE_SIZE;

    // ID (optional)
    let id = params.id;
    if (id !== undefined && id !== null) {
        id = id.toString().trim();
        if (id.length === 0) id = undefined;
    }

    return { errors, cleaned: { keywords, pages, size, id } };
}

function addToCache(key, data) {
    // Enforce cache size limit (FIFO eviction)
    if (requestCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = requestCache.keys().next().value;
        requestCache.delete(oldestKey);
    }
    requestCache.set(key, { expiry: Date.now() + CACHE_TTL, data });
}

const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const clientIp = getClientIp(req);

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // Parse URL (using WHATWG URL API instead of deprecated url.parse)
    let pathname;
    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        pathname = parsedUrl.pathname;
    } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    // CORS
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- Health Check (exempt from rate limit) ---
    if (pathname === '/api/health' && req.method === 'GET') {
        const health = {
            status: 'ok',
            uptime: Math.round(process.uptime()),
            cacheSize: requestCache.size,
            levenshteinCacheSize: levenshteinCache.size,
            memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            timestamp: Date.now()
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    // --- Static File Serving (non-API routes) ---
    if (!pathname.startsWith('/api/')) {
        serveStaticFile(pathname, res);
        return;
    }

    // --- Rate Limiting (API only) ---
    const currentCount = ipRequestCounts.get(clientIp) || 0;
    if (currentCount >= RATE_LIMIT_MAX) {
        log('warn', 'Rate limit exceeded', { ip: clientIp });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' }));
        return;
    }
    ipRequestCounts.set(clientIp, currentCount + 1);

    // --- API Route Mapping ---
    let apiPath = '';
    if (pathname === '/api/search') apiPath = '/api/v2/search';
    else if (pathname === '/api/product') apiPath = '/api/v2/searchByIdentity';
    else if (pathname === '/api/similar') apiPath = '/api/v2/searchSmilarProduct';
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
        return;
    }

    // Only POST allowed for API endpoints
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    try {
        // Read body with size limit
        let body;
        try {
            body = await readBody(req);
        } catch (err) {
            if (err.message === 'PAYLOAD_TOO_LARGE') {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'İstek boyutu çok büyük' }));
                return;
            }
            throw err;
        }

        // Parse and validate
        let params;
        try {
            params = JSON.parse(body);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Geçersiz JSON' }));
            return;
        }

        // Input validation for search endpoint
        if (pathname === '/api/search') {
            const { errors, cleaned } = validateSearchParams(params);
            if (errors.length > 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: errors.join(', ') }));
                return;
            }
            params = cleaned;
        }

        // Cache Check (Normalized Key)
        let normalizedBody;
        try {
            const sorted = {};
            Object.keys(params).sort().forEach(key => sorted[key] = params[key]);
            normalizedBody = JSON.stringify(sorted);
        } catch { normalizedBody = body; }

        const cacheKey = `${pathname}_${normalizedBody}`;
        if (requestCache.has(cacheKey)) {
            const entry = requestCache.get(cacheKey);
            if (Date.now() < entry.expiry) {
                log('info', 'Cache hit', { path: pathname, duration: Date.now() - startTime });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(entry.data));
                return;
            }
            requestCache.delete(cacheKey);
        }

        const postData = JSON.stringify({
            id: params.id,
            keywords: params.keywords || '',
            pages: params.pages || 0,
            size: params.size || 24
        });

        const options = {
            hostname: 'api.marketfiyati.org.tr',
            port: 443,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };

        const upstreamStart = Date.now();
        const result = await makeRequestWithRetry(options, postData);
        const upstreamDuration = Date.now() - upstreamStart;

        // LOGIC APPLICATION: If search, GROUP the results before sending
        let finalData = result.data;
        if (pathname === '/api/search' && result.status === 200) {
            const raw = result.data.content || result.data;
            if (Array.isArray(raw)) {
                finalData = groupProducts(raw);
            }
        }

        if (result.status === 200) {
            addToCache(cacheKey, finalData);
        }

        log('info', 'API request', {
            path: pathname,
            ip: clientIp,
            upstream: upstreamDuration + 'ms',
            total: (Date.now() - startTime) + 'ms',
            status: result.status,
            cached: false
        });

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalData));

    } catch (error) {
        log('error', 'Request failed', {
            path: pathname,
            ip: clientIp,
            error: error.message,
            duration: (Date.now() - startTime) + 'ms'
        });

        // Sanitized error response — never expose internal details to client
        const isTimeout = error.message?.includes('timeout') || error.message?.includes('Timeout');
        const statusCode = isTimeout ? 504 : 500;
        const clientMessage = isTimeout
            ? 'Sunucu yanıt vermedi, lütfen tekrar deneyin'
            : 'Bir hata oluştu, lütfen tekrar deneyin';

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: clientMessage }));
    }
});

// --- 6. GRACEFUL SHUTDOWN ---

let isShuttingDown = false;

function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log('info', 'Shutdown initiated', { signal });

    // Stop accepting new connections
    server.close(() => {
        log('info', 'Server closed gracefully');
        cleanupTimers.forEach(t => clearInterval(t));
        process.exit(0);
    });

    // Force exit after 5 seconds if connections don't drain
    setTimeout(() => {
        log('warn', 'Forcing shutdown after timeout');
        process.exit(1);
    }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- START ---

server.listen(PORT, () => {
    log('info', 'Server started', {
        port: PORT,
        trustProxy: TRUST_PROXY,
        corsOrigins: ALLOWED_ORIGINS.length,
        env: process.env.NODE_ENV || 'development'
    });
});