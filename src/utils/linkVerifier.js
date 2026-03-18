/**
 * Link verification utility for article content.
 *
 * Extracts and validates external links (HTTP/HTTPS) from HTML content.
 * Removes broken links while preserving anchor text. Uses concurrency
 * limiting to avoid hammering servers.
 *
 * ENHANCED: Also detects and removes Google News redirect URLs,
 * and flags links not present in the verified sources list (fabrication detection).
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const MAX_CONCURRENT_CHECKS = 3;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Domains that should never appear in published article links
const BLOCKED_DOMAINS = [
  'news.google.com',
  'consent.google.com',
  'accounts.google.com',
];

/**
 * Extract all links from HTML content and verify them.
 * Returns both fixed HTML and detailed stats about broken/removed links.
 *
 * @param {string} htmlContent - The HTML article content
 * @param {string} [siteDomain] - Optional domain to skip (internal links)
 * @param {Array<{url: string}>} [verifiedSources] - Optional list of verified source URLs for fabrication detection
 * @returns {Promise<Object>} { fixedHtml, brokenLinks, totalLinks, googleNewsLinks, fabricatedLinks, details }
 */
export async function verifyAndFixLinks(htmlContent, siteDomain = null, verifiedSources = []) {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return {
      fixedHtml: htmlContent || '',
      brokenLinks: 0,
      totalLinks: 0,
      googleNewsLinks: 0,
      fabricatedLinks: 0,
      details: [],
    };
  }

  // Extract all <a href="..."> tags
  const linkRegex = /<a\s+(?:[^>]*?\s)?href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  const links = [];
  let match;

  while ((match = linkRegex.exec(htmlContent)) !== null) {
    const href = match[1];
    const text = match[2];

    // Skip non-external links
    if (shouldSkipLink(href, siteDomain)) {
      continue;
    }

    links.push({
      href,
      text,
      fullMatch: match[0],
      index: match.index,
    });
  }

  const totalLinks = links.length;
  let fixedHtml = htmlContent;
  const details = [];

  if (totalLinks === 0) {
    return {
      fixedHtml,
      brokenLinks: 0,
      totalLinks: 0,
      googleNewsLinks: 0,
      fabricatedLinks: 0,
      details: [],
    };
  }

  // Build a set of verified source domains+paths for fabrication detection
  const verifiedUrlSet = new Set(verifiedSources.map(s => s.url));

  // Step 1: Pre-filter blocked domains (Google News, etc.) before HTTP checks
  const { clean: cleanLinks, blocked: blockedLinks } = preFilterBlockedDomains(links);
  let googleNewsCount = 0;

  for (const blocked of blockedLinks) {
    googleNewsCount++;
    details.push({
      url: blocked.href,
      status: 'blocked_domain',
      action: 'removed',
    });

    // Remove the link from HTML, keep anchor text
    const oldLink = blocked.fullMatch;
    const newContent = `${blocked.text}<!-- LINK REMOVED: Google News/blocked redirect URL -->`;
    const searchIndex = fixedHtml.indexOf(oldLink);
    if (searchIndex !== -1) {
      fixedHtml = fixedHtml.substring(0, searchIndex) + newContent + fixedHtml.substring(searchIndex + oldLink.length);
    }
    console.log(`[LinkVerifier] Blocked domain link removed: ${blocked.href}`);
  }

  // Step 2: Verify remaining links with concurrency limit
  const verified = await verifyLinksWithConcurrency(cleanLinks);

  // Step 3: Process broken links, and check for fabricated links
  let brokenCount = 0;
  let fabricatedCount = 0;

  for (const result of verified) {
    // Check if this link was in the verified sources (fabrication detection)
    const isFabricated = verifiedUrlSet.size > 0 && !isInVerifiedSources(result.href, verifiedUrlSet);

    if (isFabricated && !result.isBroken) {
      fabricatedCount++;
      details.push({
        url: result.href,
        status: result.status,
        action: 'flagged_fabricated',
      });
      console.log(`[LinkVerifier] Fabricated link detected (not in verified sources): ${result.href}`);
      // Don't remove fabricated links automatically — they may be legitimate editorial links.
      // Just log them for now. Future: could strip or replace with text-only references.
    } else {
      details.push({
        url: result.href,
        status: result.status,
        action: result.isBroken ? 'removed' : 'kept',
      });
    }

    if (result.isBroken) {
      brokenCount++;

      // Find and replace the link in HTML
      const oldLink = result.fullMatch;
      const newContent = `${result.text}<!-- LINK REMOVED: original URL was broken -->`;

      const searchIndex = fixedHtml.indexOf(oldLink);
      if (searchIndex !== -1) {
        fixedHtml = fixedHtml.substring(0, searchIndex) + newContent + fixedHtml.substring(searchIndex + oldLink.length);
      }

      console.log(`[LinkVerifier] Broken link removed: ${result.href} (${result.status})`);
    }
  }

  return {
    fixedHtml,
    brokenLinks: brokenCount,
    totalLinks,
    googleNewsLinks: googleNewsCount,
    fabricatedLinks: fabricatedCount,
    details,
  };
}

/**
 * Pre-filter links to remove any pointing to blocked domains.
 * Returns { clean: [...], blocked: [...] }
 */
function preFilterBlockedDomains(links) {
  const clean = [];
  const blocked = [];

  for (const link of links) {
    try {
      const parsed = new URL(link.href);
      if (BLOCKED_DOMAINS.some(d => parsed.hostname.includes(d))) {
        blocked.push(link);
      } else {
        clean.push(link);
      }
    } catch {
      // If URL can't be parsed, still check as string
      if (BLOCKED_DOMAINS.some(d => link.href.includes(d))) {
        blocked.push(link);
      } else {
        clean.push(link);
      }
    }
  }

  return { clean, blocked };
}

/**
 * Check if a URL matches any of the verified source URLs.
 * Uses domain+path matching to be somewhat flexible (ignore query params, fragments).
 */
function isInVerifiedSources(href, verifiedUrlSet) {
  // Direct match
  if (verifiedUrlSet.has(href)) return true;

  // Try without trailing slash
  if (verifiedUrlSet.has(href.replace(/\/$/, ''))) return true;
  if (verifiedUrlSet.has(href + '/')) return true;

  // Check if the domain+path matches any verified URL (ignore query/fragment)
  try {
    const parsed = new URL(href);
    const normalized = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    for (const vUrl of verifiedUrlSet) {
      try {
        const vParsed = new URL(vUrl);
        const vNormalized = `${vParsed.origin}${vParsed.pathname}`.replace(/\/$/, '');
        if (normalized === vNormalized) return true;
      } catch {}
    }
  } catch {}

  return false;
}

/**
 * Check if a link should be skipped during verification.
 * Skips: relative URLs, mailto, anchors, and internal site links.
 */
function shouldSkipLink(href, siteDomain) {
  const trimmed = href.trim();

  // Skip empty, relative, mailto, and anchor-only links
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.startsWith('mailto:')
  ) {
    return true;
  }

  // Skip internal links if siteDomain is provided
  if (siteDomain && trimmed.includes(siteDomain)) {
    return true;
  }

  // Only process http/https URLs
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return true;
  }

  return false;
}

/**
 * Verify multiple links with concurrency control.
 */
async function verifyLinksWithConcurrency(links) {
  const results = [];
  const queue = [...links];
  const inFlight = new Set();

  return new Promise((resolve) => {
    const processNext = async () => {
      if (queue.length === 0 && inFlight.size === 0) {
        resolve(results);
        return;
      }

      while (inFlight.size < MAX_CONCURRENT_CHECKS && queue.length > 0) {
        const link = queue.shift();
        inFlight.add(link);

        verifyLink(link)
          .then((result) => {
            results.push(result);
            inFlight.delete(link);
            processNext();
          })
          .catch((err) => {
            // Treat errors as broken links
            results.push({
              ...link,
              status: `error: ${err.message}`,
              isBroken: true,
            });
            inFlight.delete(link);
            processNext();
          });
      }
    };

    processNext();
  });
}

/**
 * Verify a single link via HTTP GET request.
 * Follows redirects up to MAX_REDIRECTS.
 */
function verifyLink(link, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    const checkUrl = (url) => {
      let protocol;
      try {
        protocol = new URL(url).protocol;
      } catch (err) {
        resolve({
          ...link,
          status: 'invalid URL',
          isBroken: true,
        });
        return;
      }

      const client = protocol === 'https:' ? https : http;
      const req = client.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
        },
      }, (res) => {
        // Consume body to free socket
        res.resume();
        const statusCode = res.statusCode;

        // Follow redirects manually
        if ((statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308) && redirectsRemaining > 0) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            let absoluteUrl;
            try {
              const baseUrl = new URL(url);
              absoluteUrl = new URL(redirectUrl, baseUrl).toString();
            } catch {
              absoluteUrl = redirectUrl;
            }

            // If redirect lands on a blocked domain, treat as broken
            if (BLOCKED_DOMAINS.some(d => absoluteUrl.includes(d))) {
              resolve({
                ...link,
                status: 'redirects_to_blocked_domain',
                isBroken: true,
              });
              return;
            }

            checkUrl(absoluteUrl); // Recurse with redirect
            return;
          }
        }

        // 2xx = good, everything else = broken
        if (statusCode >= 200 && statusCode < 300) {
          resolve({
            ...link,
            status: statusCode,
            isBroken: false,
          });
        } else {
          resolve({
            ...link,
            status: statusCode,
            isBroken: true,
          });
        }
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          ...link,
          status: 'timeout',
          isBroken: true,
        });
      });

      req.on('error', (err) => {
        resolve({
          ...link,
          status: `error: ${err.code || err.message}`,
          isBroken: true,
        });
      });

      req.end();
    };

    checkUrl(link.href);
  });
}
