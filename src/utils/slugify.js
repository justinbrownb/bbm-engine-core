// Unified slug generator for all BBM content engines
// MUST include the FULL title, never shortened
// Each engine passes its own prefix config and optional slugExists checker

/**
 * Convert a title to a URL-safe slug string.
 * @param {string} title
 * @returns {string}
 */
export function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a slug with a configurable prefix.
 *
 * @param {string} title - Article title
 * @param {Object} options
 * @param {string} options.prefix - Slug prefix (e.g. 'dmn-', 'sc-a-', 'vo-n-')
 * @param {boolean} [options.pitch=false] - If true, insert '-p' before the final dash (e.g. 'dmn-p-', 'sc-a-p-')
 * @param {Function} [options.slugExists] - Async function that checks if slug exists in WordPress. If not provided, no dedup check.
 * @returns {Promise<string>} The generated slug
 */
export async function generateSlug(title, { prefix, pitch = false, slugExists = null } = {}) {
  if (!prefix) throw new Error('slugify: prefix is required');

  // Insert pitch modifier: 'dmn-' → 'dmn-p-', 'sc-a-' → 'sc-a-p-'
  let finalPrefix = prefix;
  if (pitch) {
    finalPrefix = prefix.slice(0, -1) + 'p-';
  }

  const base = finalPrefix + toSlug(title);

  // If no slugExists checker provided, return base slug directly
  if (!slugExists) return base;

  // Check WordPress for duplicates
  const exists = await slugExists(base);
  if (!exists) return base;

  // Append random suffix for uniqueness
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Resolve a tier name to its slug prefix using a prefix map.
 * Convenience for engines with tier-based prefixes (SC, VegOut, TYB).
 *
 * @param {string} tier - Tier name (e.g. 'psychology', 'news', 'discover')
 * @param {Object} tierPrefixes - Map of tier name → prefix (e.g. { psychology: 'sc-a-', news: 'sc-n-' })
 * @param {string} [defaultPrefix] - Fallback prefix if tier not found
 * @returns {string} The prefix for this tier
 */
export function getPrefixForTier(tier, tierPrefixes, defaultPrefix = '') {
  return tierPrefixes[tier] || defaultPrefix;
}
