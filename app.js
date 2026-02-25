// Fiyat Kıyası Frontend
// Pure UI Logic (Rendering Only) + Infinite Scroll
// Backend does the heavy lifting via /api/search

// API Base URL - Auto-detects Environment
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const isFileProtocol = window.location.protocol === 'file:';
const API_BASE = (isFileProtocol || (isLocalHost && window.location.port !== '3001'))
    ? 'http://localhost:3001/api'
    : '/api';

let searchController = null; // Global AbortController

// Pagination State
let currentPage = 0;
let currentKeywords = '';
let isLoading = false;
let hasMoreResults = true;
const PAGE_SIZE = 24;

// Cross-page dedup: track seen product titles to prevent duplicates across pages
let seenProductKeys = new Set();

// HTML escape utility to prevent XSS
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const marketNames = {
    'a101': 'A101', 'bim': 'BİM', 'migros': 'Migros', 'carrefour': 'CarrefourSA',
    'carrefoursa': 'CarrefourSA', 'sok': 'ŞOK', 'hakmar': 'Hakmar', 'tarim_kredi': 'Tarım Kredi'
};

function getMarketName(key) {
    if (!key) return 'Market';
    const k = key.toLowerCase().replace(/\s+/g, '_');
    return marketNames[k] || key;
}

const suggestions = ["Süt", "Yumurta", "Sıvı Yağ", "Peynir", "Çay", "Deterjan", "Kola"];

document.addEventListener('DOMContentLoaded', () => {
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('productSearch');

    typeWriter(searchInput);

    if (searchBtn && searchInput) {
        let timeout = null;

        const triggerSearch = (immediate = false) => {
            const q = searchInput.value.replace(/kaça\??/gi, '').trim();
            if (immediate) clearTimeout(timeout);
            if (q.length > 2) {
                // Reset pagination for new search
                currentPage = 0;
                currentKeywords = q;
                hasMoreResults = true;
                seenProductKeys = new Set(); // Reset dedup for new search
                if (immediate) search(q, true);
                else {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => search(q, true), 600);
                }
            }
        };

        searchInput.addEventListener('input', () => triggerSearch(false));
        searchBtn.addEventListener('click', () => triggerSearch(true));
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                triggerSearch(true);
            }
        });
    }

    // Infinite Scroll
    setupInfiniteScroll();
});

function setupInfiniteScroll() {
    let ticking = false;

    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                checkScroll();
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });
}

function checkScroll() {
    if (isLoading || !hasMoreResults || !currentKeywords) return;

    const scrollY = window.scrollY;
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight;

    // Trigger when 300px from bottom
    if (scrollY + windowHeight >= documentHeight - 300) {
        loadMoreResults();
    }
}

async function loadMoreResults() {
    if (isLoading || !hasMoreResults) return;

    const previousPage = currentPage;
    currentPage++;
    const ok = await search(currentKeywords, false);
    if (!ok) {
        currentPage = previousPage;
    }
}

function typeWriter(input) {
    let i = 0; let txtIdx = 0; let isDeleting = false;
    function type() {
        const currentTxt = suggestions[txtIdx % suggestions.length];
        if (isDeleting) { input.placeholder = currentTxt.substring(0, i - 1); i--; }
        else { input.placeholder = currentTxt.substring(0, i + 1); i++; }

        let speed = 100;
        if (!isDeleting && i === currentTxt.length) { isDeleting = true; speed = 2000; }
        else if (isDeleting && i === 0) { isDeleting = false; txtIdx++; speed = 500; }
        else if (isDeleting) speed = 50;
        setTimeout(type, speed);
    }
    type();
}

async function search(keywords, isNewSearch = true) {
    if (searchController && isNewSearch) searchController.abort();
    searchController = new AbortController();

    isLoading = true;
    let requestSucceeded = false;

    const listView = document.getElementById('listView');
    listView.style.display = 'block';

    if (isNewSearch) {
        // SKELETON LOADING for new search
        listView.innerHTML = `
            <div class="product-grid">
                ${Array(4).fill(0).map(() => `
                    <div class="skeleton-card">
                        <div class="skeleton-pulse"></div>
                        <div class="skeleton-img"></div>
                        <div class="skeleton-content">
                            <div class="skeleton-line" style="width: 60%"></div>
                            <div class="skeleton-line" style="width: 40%"></div>
                            <div class="skeleton-line" style="width: 30%"></div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        // Show loading indicator at bottom for infinite scroll
        showLoadingMore();
    }

    try {
        // Request larger page size because backend groups products (reduces count)
        const requestSize = 50;

        const res = await fetch(`${API_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keywords, pages: currentPage, size: requestSize }),
            signal: searchController.signal
        });

        const data = await res.json();

        // Proper error handling: check HTTP status and error responses
        if (!res.ok) {
            const errorMsg = data?.error || `Hata (${res.status})`;
            if (isNewSearch) {
                listView.innerHTML = `<div class="loading-state"><p class="loading-text">${escapeHtml(errorMsg)}</p></div>`;
            }
            hideLoadingMore();
            hasMoreResults = false;
            return false;
        }

        let products = Array.isArray(data) ? data : (data.content || []);

        // Cross-page dedup: filter out products already seen in previous pages
        if (!isNewSearch) {
            products = products.filter(p => {
                const key = (p.title || '').toLowerCase().trim();
                if (seenProductKeys.has(key)) return false;
                seenProductKeys.add(key);
                return true;
            });
        } else {
            // New search: populate the seen set
            products.forEach(p => {
                const key = (p.title || '').toLowerCase().trim();
                seenProductKeys.add(key);
            });
        }

        // After grouping, results may be significantly fewer than requestSize
        // Consider "no more" if we got less than 10 grouped products
        const MIN_THRESHOLD = 10;
        hasMoreResults = products.length >= MIN_THRESHOLD;

        if (products && products.length > 0) {
            if (isNewSearch) {
                showResults(products, keywords);
            } else {
                appendResults(products);
            }
        } else if (isNewSearch) {
            listView.innerHTML = `<div class="loading-state"><p class="loading-text">Sonuç bulunamadı</p></div>`;
            hasMoreResults = false;
        } else {
            // No more results on pagination
            hasMoreResults = false;
        }

        hideLoadingMore();

        // Update end indicator
        if (!hasMoreResults) {
            const endIndicator = document.getElementById('endOfResults');
            if (endIndicator) endIndicator.style.display = 'block';
        }
        requestSucceeded = true;
    } catch (err) {
        if (err.name === 'AbortError') return false;
        console.error(err);
        const errorText = err instanceof TypeError
            ? 'API baglantisi kurulamadı. Sunucu icin terminalde "npm run dev" calistirin.'
            : 'Baglanti hatasi';
        if (isNewSearch) {
            listView.innerHTML = `<div class="loading-state"><p class="loading-text">${escapeHtml(errorText)}</p></div>`;
        }
        hideLoadingMore();
    } finally {
        isLoading = false;
    }

    return requestSucceeded;
}

function showLoadingMore() {
    let loader = document.getElementById('infiniteLoader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'infiniteLoader';
        loader.className = 'infinite-loader';
        loader.innerHTML = `
            <div class="loader-spinner"></div>
            <span>Daha fazla yükleniyor...</span>
        `;
        document.getElementById('listView').appendChild(loader);
    }
    loader.style.display = 'flex';
}

function hideLoadingMore() {
    const loader = document.getElementById('infiniteLoader');
    if (loader) loader.style.display = 'none';
}

function showResults(products, keywords) {
    const listView = document.getElementById('listView');

    // Dynamic Header Logic - use viewModel.markets for consistent naming
    let totalMarkets = new Set();
    products.forEach(p => p.viewModel?.markets?.forEach(m => totalMarkets.add(getMarketName(m.name))));

    const displayTitle = keywords.length < 30 ? `"${escapeHtml(keywords)}" için en iyi fiyatlar` : 'Arama Sonuçları';

    let html = `
        <div class="results-header">
            <span class="results-title">${displayTitle}</span>
            <span class="results-meta">
                ${products.length}+ ürün bulundu • ${totalMarkets.size} farklı marketten fiyatlar
            </span>
        </div>
        <div class="product-grid" id="productGrid">
    `;

    products.forEach((p) => {
        html += renderProductCard(p);
    });

    html += '</div>';

    // End of results indicator (hidden by default)
    html += '<div id="endOfResults" class="end-of-results" style="display: none;">Tüm sonuçlar yüklendi</div>';

    listView.innerHTML = html;

    // Show end indicator if no more results
    if (!hasMoreResults) {
        document.getElementById('endOfResults').style.display = 'block';
    }
}

function appendResults(products) {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    products.forEach((p) => {
        const card = document.createElement('div');
        card.innerHTML = renderProductCard(p);
        grid.appendChild(card.firstElementChild);
    });

    // Show end indicator if no more results
    if (!hasMoreResults) {
        const endIndicator = document.getElementById('endOfResults');
        if (endIndicator) endIndicator.style.display = 'block';
    }
}

function renderProductCard(p) {
    const vm = p.viewModel;
    if (!vm) return '';

    // Özet Bilgi (2. Katman)
    let summaryHtml = '';
    if (vm.marketCount > 0) {
        const countText = `${vm.marketCount} markette`;
        const saveText = vm.savings > 0 ? `<span class="summary-dot"></span><span class="summary-highlight">%${vm.savings} daha ucuz</span>` : '';
        summaryHtml = `<div class="summary-info">${countText} ${saveText}</div>`;
    } else {
        summaryHtml = `<div class="summary-info">Stokta yok</div>`;
    }

    // Market Listesi (3. Katman)
    let miniListHtml = '';
    if (vm.markets.length > 0) {
        miniListHtml = '<div class="mini-market-list">';
        vm.markets.forEach((m, idx) => {
            const isBest = idx === 0;
            let unitPriceHtml = '';
            if (m.unitPrice && vm.unit) {
                unitPriceHtml = `<span class="unit-price-tag">(${m.unitPrice} ₺/${vm.unit})</span>`;
            }

            miniListHtml += `
                <div class="mini-market-item ${isBest ? 'best' : ''}">
                    <div class="mini-market-row">
                        <div class="mini-market-col-left">
                            <span class="mini-market-name">${escapeHtml(getMarketName(m.name))}</span>
                        </div>
                        <div class="mini-market-col-right">
                            <span class="mini-market-price">₺${m.price.toFixed(2)}</span>
                            ${unitPriceHtml}
                        </div>
                    </div>
                </div>
            `;
        });
        miniListHtml += '</div>';
    }

    // Smart Badge
    let badgeHtml = '';
    if (vm.badge) {
        badgeHtml = `<div class="smart-badge ${vm.badge.type}">${vm.badge.text}</div>`;
    }

    return `
        <div class="product-card">
            <div class="product-header">
                ${badgeHtml}
                ${p.imageUrl ?
            `<img src="${escapeHtml(p.imageUrl)}" class="product-img" alt="${escapeHtml(p.title)}" loading="lazy" onerror="this.outerHTML='<div class=product-img-placeholder>No Image</div>'">` :
            '<div class="product-img-placeholder">No Image</div>'
        }
            </div>
            
            <div class="product-info">
                <div class="product-brand">${escapeHtml(p.brand) || 'Markasız'}</div>
                <div class="product-title">${escapeHtml(p.title)}</div>
                ${summaryHtml}
                ${miniListHtml} 
            </div>

            <div class="product-prices">
                <div class="price-container">
                    <span class="price-currency">₺</span>
                    <span class="price-range">${vm.minPrice.toFixed(2)}</span>
                </div>
                
                <div class="price-details">
                     ${vm.maxPrice > vm.minPrice ? `<span class="price-max">₺${vm.maxPrice.toFixed(2)}</span>` : ''}
                     ${vm.markets[0]?.unitPrice ? `<span class="price-max price-unit-main">${vm.markets[0].unitPrice} ₺/${vm.unit}</span>` : ''}
                </div>
            </div>
        </div>
    `;
}
