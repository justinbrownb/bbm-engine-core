// Fetch Google Discover performance learnings from the performance-reporter service.
// These data-driven insights are injected into title generation prompts.

const LEARNINGS_URL = process.env.LEARNINGS_URL || 'https://performance-reporter-production.up.railway.app';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedLearnings = null;
let cacheTimestamp = 0;

/**
 * Fetch learnings for a specific site (or collective insights).
 * Returns a string ready for prompt injection, or empty string if unavailable.
 *
 * @param {string} siteId - e.g. 'geediting', 'siliconcanals', 'dmnews', etc.
 * @returns {string} Formatted learnings text for prompt injection
 */
export async function fetchDiscoverLearnings(siteId) {
  try {
    // Check cache
    if (cachedLearnings && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
      return cachedLearnings;
    }

    const url = `${LEARNINGS_URL}/learnings/${siteId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[Learnings] No learnings available for ${siteId} (${res.status})`);
      return '';
    }

    const data = await res.json();
    if (data.promptText) {
      cachedLearnings = data.promptText;
      cacheTimestamp = Date.now();
      console.log(`[Learnings] Loaded insights from ${data.weekLabel} for ${siteId}`);
      return data.promptText;
    }

    return '';
  } catch (e) {
    // Non-fatal — title generation works fine without learnings
    console.log(`[Learnings] Could not fetch (${e.message}) — continuing without insights`);
    return '';
  }
}
