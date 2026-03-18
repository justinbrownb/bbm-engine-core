// Prompt Service Client — engines use this to load prompts from the BBM Prompt API
// Caches prompts for 1 minute to avoid hammering the API every cycle
// Falls back to last-cached version if API is unreachable

import https from 'https';
import http from 'http';

const PROMPT_API_URL = process.env.PROMPT_API_URL || 'http://localhost:3001';
const CACHE_TTL_MS = 60000; // 1 minute

// In-memory cache: { key: { data, fetchedAt } }
const cache = new Map();

/**
 * Fetch a prompt section from the API with caching.
 * @param {string} engine - Engine ID (dmnews, sc, vo, tyb)
 * @param {string} section - Section name (titles, articles, authors, editorial, etc.)
 * @returns {Promise<Object|null>} The prompt data, or null if unavailable
 */
export async function getPrompts(engine, section) {
  const cacheKey = `${engine}:${section}`;
  const cached = cache.get(cacheKey);

  // Return cached if still fresh
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `${PROMPT_API_URL}/api/prompts/${engine}/${section}`;
    const data = await fetchJSON(url);

    // Cache the result
    cache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  } catch (e) {
    console.warn(`[PromptService] Failed to fetch ${engine}/${section}: ${e.message}`);

    // Fall back to stale cache if available
    if (cached) {
      console.warn(`[PromptService] Using stale cache for ${engine}/${section} (${Math.round((Date.now() - cached.fetchedAt) / 1000)}s old)`);
      return cached.data;
    }

    return null;
  }
}

/**
 * Fetch a shared prompt section.
 * @param {string} section - Section name (opening_styles, quality_criteria, etc.)
 */
export async function getSharedPrompts(section) {
  return getPrompts('shared', section);
}

/**
 * Preload all sections for an engine into cache.
 * Call this at engine startup to populate the cache.
 * @param {string} engine - Engine ID
 * @param {string[]} sections - Sections to preload
 */
export async function preloadPrompts(engine, sections) {
  const results = await Promise.allSettled(
    sections.map(s => getPrompts(engine, s))
  );

  const loaded = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[PromptService] Preloaded ${loaded}/${sections.length} sections for ${engine}`);
  return loaded;
}

/**
 * Clear the cache (useful for testing or forced refresh).
 */
export function clearPromptCache() {
  cache.clear();
}

/**
 * Get cache stats (for health/debug endpoints).
 */
export function getPromptCacheStats() {
  const entries = [];
  for (const [key, val] of cache.entries()) {
    entries.push({
      key,
      ageMs: Date.now() - val.fetchedAt,
      fresh: Date.now() - val.fetchedAt < CACHE_TTL_MS,
    });
  }
  return { entries, size: cache.size, ttlMs: CACHE_TTL_MS };
}

// --- Internal HTTP fetch ---

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}
