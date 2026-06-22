const WARERA_BASE = 'https://api2.warera.io/trpc';

// ─── Rate Limiter ────────────────────────────────
// API limit: 100 req/60s → we use 80 req/60s to be safe
const RATE_MAX = 80;
const RATE_WINDOW = 60000;

const queue = [];
let activeTokens = RATE_MAX;
let lastRefill = Date.now();

function refillTokens() {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const refill = Math.floor(elapsed / RATE_WINDOW) * RATE_MAX;
  if (refill > 0) {
    activeTokens = Math.min(RATE_MAX, activeTokens + refill);
    lastRefill = now;
  }
}

async function acquireToken() {
  refillTokens();
  if (activeTokens > 0) {
    activeTokens--;
    return;
  }
  // Wait for a token
  return new Promise(resolve => {
    queue.push(resolve);
    processQueue();
  });
}

function processQueue() {
  if (queue.length === 0) return;
  refillTokens();
  while (queue.length > 0 && activeTokens > 0) {
    activeTokens--;
    queue.shift()();
  }
  if (queue.length > 0) {
    const waitMs = Math.ceil(RATE_WINDOW / RATE_MAX);
    setTimeout(processQueue, waitMs);
  }
}

// Auto-refill tokens every minute
setInterval(() => {
  refillTokens();
  processQueue();
}, 5000);

// ─── Auth ────────────────────────────────────────
function getApiKey() {
  return localStorage.getItem('warera_api_key') || '';
}

function setApiKey(key) {
  localStorage.setItem('warera_api_key', key);
}

function clearApiKey() {
  localStorage.removeItem('warera_api_key');
}

// ─── Core API call ───────────────────────────────
async function apiCall(method, params = {}) {
  await acquireToken();

  const apiKey = getApiKey();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const inputJson = JSON.stringify(params);
  const url = `${WARERA_BASE}/${method}?input=${encodeURIComponent(inputJson)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '10');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API error ${res.status}: ${text || res.statusText}`);
      }

      const body = await res.json();
      if (body.error) {
        throw new Error(body.error.message || JSON.stringify(body.error));
      }
      return body.result ? body.result.data : body;
    } catch (err) {
      if (attempt === 2) throw err;
      if (err.message.includes('429')) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// Paginated helper for endpoints with cursor
// stopDate: if set, stop paginating when cursor date is before stopDate (for backward direction)
async function apiCallAll(method, params, extractFn, stopDate) {
  const items = [];
  let cursor = null;
  while (true) {
    const p = { ...params, limit: params.limit || 50 };
    if (cursor) p.cursor = cursor;

    const data = await apiCall(method, p);
    const batch = extractFn(data);
    if (!batch || batch.length === 0) break;
    items.push(...batch);

    const nextCursor = data.nextCursor || data.next_cursor || null;
    if (!nextCursor) break;

    // Stop if cursor date is before cutoff (for backward pagination)
    if (stopDate && typeof nextCursor === 'string') {
      const cursorDate = nextCursor.split('|')[0];
      const cursorTime = new Date(cursorDate).getTime();
      if (!isNaN(cursorTime) && cursorTime < stopDate.getTime()) break;
    }

    cursor = nextCursor;
  }
  return items;
}

function extractItems(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (typeof response === 'object') {
    for (const key of ['items', 'data', 'results', 'rankings']) {
      const val = response[key];
      if (Array.isArray(val)) return val;
    }
  }
  return [];
}

// ─── Warera API methods ────────────────────────

const Warera = {
  async getAllCountries() {
    return apiCall('country.getAllCountries', {});
  },

  async getCountryById(countryId) {
    return apiCall('country.getCountryById', { countryId });
  },

  async getRegionById(regionId) {
    if (!regionId) return null;
    return apiCall('region.getById', { regionId });
  },

  async getAllRegions() {
    return apiCall('region.getRegionsObject', {});
  },

  async getBattleById(battleId) {
    return apiCall('battle.getById', { battleId });
  },

  async getBattles(params) {
    return apiCall('battle.getBattles', params);
  },

  async getAllBattles(params, stopDate) {
    return apiCallAll('battle.getBattles', params, (d) => d.items || extractItems(d), stopDate);
  },

  async getContracts(params) {
    return apiCall('mercenaryContractAuction.getPaginatedAuctions', params);
  },

  async getAllContracts(params) {
    return apiCallAll('mercenaryContractAuction.getPaginatedAuctions', params, extractItems);
  },

  async getRanking(params) {
    return apiCall('battleRanking.getRanking', params);
  },

  async getAllRanking(params) {
    return apiCallAll('battleRanking.getRanking', params, extractItems);
  },

  async getMuById(muId) {
    return apiCall('mu.getById', { muId });
  },

  async search(query) {
    return apiCall('search.searchAnything', { searchText: query });
  },
};
