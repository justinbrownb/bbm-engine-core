/**
 * LINK CHECKER — Validates all external URLs in article HTML
 *
 * Used in two contexts:
 * 1. Publishers (post-factCheck, pre-publish): strips dead links from article before publishing
 * 2. Quality editor (pre-review): provides verified link status to reviewer
 *
 * Makes HTTP HEAD requests with redirect following, timeout, and bot-friendly User-Agent.
 * Treats 403 as "probably OK" (many sites block HEAD requests but the page exists).
 * Treats 404, 410, 5xx, timeout, DNS failure as dead.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 5; // Check 5 URLs at a time to avoid hammering

/**
 * Extract all external URLs from article HTML.
 * Skips internal links (same domain), image credits (Pexels/Flickr/Unsplash), and anchors.
 *
 * @param {string} html - Article HTML content
 * @param {string} [siteDomain] - Own site domain to exclude (e.g., 'geediting.com')
 * @returns {Array<{url: string, anchorText: string}>}
 */
export function extractExternalUrls(html, siteDomain = null) {
  const linkRegex = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const urls = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1].trim();
    const anchorText = match[2].replace(/<[^>]+>/g, '').trim(); // Strip inner HTML tags

    // Skip duplicates
    if (seen.has(url)) continue;
    seen.add(url);

    // Skip own domain
    if (siteDomain && url.includes(siteDomain)) continue;

    // Skip image credit links — these are NOT article source links
    if (/pexels\.com|flickr\.com|unsplash\.com|pixabay\.com/i.test(url)) continue;

    // Skip social media share/profile links
    if (/twitter\.com|x\.com\/intent|facebook\.com\/sharer|linkedin\.com\/share/i.test(url)) continue;

    urls.push({ url, anchorText });
  }

  return urls;
}

/**
 * Soft-404 detection: Some sites (SPAs like APA PsycNet) return HTTP 200
 * for non-existent pages because they serve a generic JS shell that handles
 * routing client-side. The "not found" only shows after JavaScript runs.
 *
 * This function does a GET and checks the response body for signs of a
 * generic SPA shell with no real content:
 * - Very small body (< 15KB)
 * - Generic title (no page-specific content)
 * - SPA loading indicators (e.g., <app>Loading...</app>)
 * - No Open Graph or citation meta tags
 * - Known "not found" / "error" text patterns
 *
 * Returns true if the page looks like a soft 404 (dead), false if it has real content.
 */
function checkForSoft404(url) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      resolve(false); // Can't parse, let normal check handle it
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    let bodyChunks = [];
    let totalBytes = 0;
    const MAX_BODY = 50000; // Only read first 50KB

    const req = client.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      // If we get a non-200 status on GET, it's not a soft-404 issue
      // (it's a real error that the normal checker would catch)
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        resolve(false);
        return;
      }

      res.on('data', (chunk) => {
        if (totalBytes < MAX_BODY) {
          bodyChunks.push(chunk);
          totalBytes += chunk.length;
        }
      });

      res.on('end', () => {
        const body = Buffer.concat(bodyChunks).toString('utf-8').substring(0, MAX_BODY);
        const isSoft404 = detectSoft404Patterns(body, url);
        resolve(isSoft404);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Analyze HTML body for soft-404 patterns.
 * Returns true if the page looks like it's NOT serving real content.
 */
function detectSoft404Patterns(body, url) {
  const bodyLower = body.toLowerCase();

  // 1. Check for explicit "not found" patterns in the body
  const notFoundPatterns = [
    'page not found',
    'record not found',
    'article not found',
    '404 not found',
    'not found</h1>',
    'not found</title>',
    'does not exist',
    'no longer available',
    'has been removed',
    'could not be found',
    'we couldn\'t find',
    'we can\'t find',
    'this page doesn\'t exist',
    'this page does not exist',
    'error 404',
    'page you requested was not found',
  ];
  for (const pattern of notFoundPatterns) {
    if (bodyLower.includes(pattern)) {
      console.log(`[LinkChecker] Soft-404 detected (body contains "${pattern}"): ${url}`);
      return true;
    }
  }

  // 2. SPA shell detection — small body with no real content
  // Only flag if ALL of these are true:
  //   a) Body is very small (< 15KB — real articles are much bigger)
  //   b) No Open Graph or citation meta tags (real content pages have these)
  //   c) Has SPA loading indicators
  if (body.length < 15000) {
    const hasOgTags = /meta\s+property="og:(title|description)"/i.test(body);
    const hasCitationTags = /meta\s+name="citation_(title|doi|author)"/i.test(body);
    const hasSchemaOrg = /"@type"\s*:\s*"(Article|ScholarlyArticle|NewsArticle)"/i.test(body);
    const hasRealContent = hasOgTags || hasCitationTags || hasSchemaOrg;

    if (!hasRealContent) {
      // Check for SPA shell indicators
      const spaIndicators = [
        '<app>loading',
        '<div id="app"></div>',
        '<div id="root"></div>',
        '<div id="__next"></div>',
        'loading...</',
        'noscript>please enable javascript',
        'noscript>you need to enable javascript',
      ];
      const hasSpaShell = spaIndicators.some(indicator => bodyLower.includes(indicator));

      if (hasSpaShell) {
        console.log(`[LinkChecker] Soft-404 detected (SPA shell, no content meta tags, ${body.length} bytes): ${url}`);
        return true;
      }
    }
  }

  return false;
}

/**
 * Check a single URL's HTTP status.
 * Follows redirects up to MAX_REDIRECTS.
 * Returns { url, status, ok, error? }
 *
 * Status interpretation:
 * - 200-299: alive (with soft-404 check for SPA sites)
 * - 301/302/307/308 (final after redirects): alive (landed on a page)
 * - 403: alive (blocked bots but page exists — common for academic sites)
 * - 404/410: dead
 * - 5xx: dead (server error)
 * - 0: dead (timeout, DNS failure, connection refused)
 */
function checkUrl(originalUrl, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(originalUrl);
    } catch {
      resolve({ url: originalUrl, status: 0, ok: false, error: 'invalid URL' });
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(originalUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.resume();

      const status = res.statusCode;

      // Follow redirects
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        let redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location, originalUrl).toString();
        } catch {
          resolve({ url: originalUrl, status, ok: false, error: 'bad redirect URL' });
          return;
        }
        checkUrl(redirectUrl, redirectsLeft - 1).then(result => {
          resolve({ url: originalUrl, status: result.status, ok: result.ok, finalUrl: result.finalUrl || result.url, error: result.error });
        });
        return;
      }

      // Redirect loop exhausted — still a 3xx after MAX_REDIRECTS
      // This happens with cookie-gated sites (Nature, SAGE, etc.)
      // Fall back to GET which handles cookies/JS redirects better
      if (status >= 300 && status < 400) {
        console.log(`[LinkChecker] HEAD redirect loop on ${originalUrl} — falling back to GET`);
        checkUrlWithGet(originalUrl).then(resolve);
        return;
      }

      // Some servers return 405 Method Not Allowed for HEAD — retry with GET
      if (status === 405) {
        checkUrlWithGet(originalUrl).then(resolve);
        return;
      }

      // For 200 responses, check for soft-404 (SPA sites that return 200 for everything)
      // Only check if content-length is small (< 20KB) — real article pages are much bigger
      // This avoids unnecessary GET requests for obviously-valid pages
      if (status >= 200 && status < 300) {
        const contentLength = parseInt(res.headers['content-length'] || '0');
        // Only run soft-404 check if content-length is known and small (< 20KB)
        // Real article pages are typically 50KB+, SPA shells are usually < 15KB
        // If no content-length header, assume the page is real (avoids extra GET for every URL)
        if (contentLength > 0 && contentLength < 20000) {
          checkForSoft404(originalUrl).then(isSoft404 => {
            if (isSoft404) {
              console.log(`[LinkChecker] Soft-404 detected (${contentLength} bytes): ${originalUrl}`);
              resolve({ url: originalUrl, status, ok: false, finalUrl: originalUrl, error: 'soft 404 (SPA shell — page returns 200 but has no real content)' });
            } else {
              resolve({ url: originalUrl, status, ok: true, finalUrl: originalUrl });
            }
          });
          return;
        }
        resolve({ url: originalUrl, status, ok: true, finalUrl: originalUrl });
        return;
      }

      const ok = status === 403; // 403 still treated as alive (bot-blocked but page exists)
      resolve({ url: originalUrl, status, ok, finalUrl: originalUrl });
    });

    req.on('error', (e) => {
      resolve({ url: originalUrl, status: 0, ok: false, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: originalUrl, status: 0, ok: false, error: 'timeout' });
    });

    req.end();
  });
}

/**
 * Fallback GET request for servers that reject HEAD or get stuck in redirect loops.
 * Follows redirects manually to handle cookie-gated sites (Nature, SAGE, etc.).
 * Reads the response body to get the actual final status code.
 */
function checkUrlWithGet(originalUrl, redirectsLeft = 10) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(originalUrl);
    } catch {
      resolve({ url: originalUrl, status: 0, ok: false, error: 'invalid URL' });
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const seen = new Set(); // Track visited URLs to detect redirect loops

    function followGet(currentUrl, remaining) {
      if (remaining <= 0) {
        resolve({ url: originalUrl, status: 0, ok: false, error: 'redirect loop (GET)' });
        return;
      }

      // Detect redirect loops
      if (seen.has(currentUrl)) {
        resolve({ url: originalUrl, status: 0, ok: false, error: 'redirect loop (GET)' });
        return;
      }
      seen.add(currentUrl);

      let curParsed;
      try {
        curParsed = new URL(currentUrl);
      } catch {
        resolve({ url: originalUrl, status: 0, ok: false, error: 'bad redirect URL' });
        return;
      }

      const curClient = curParsed.protocol === 'https:' ? https : http;

      const req = curClient.request(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        res.resume();

        const status = res.statusCode;

        // Follow redirects
        if (status >= 300 && status < 400 && res.headers.location) {
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, currentUrl).toString();
          } catch {
            resolve({ url: originalUrl, status, ok: false, error: 'bad redirect URL' });
            return;
          }
          followGet(nextUrl, remaining - 1);
          return;
        }

        // Final status
        const ok = (status >= 200 && status < 300) || status === 403;
        resolve({ url: originalUrl, status, ok, finalUrl: currentUrl });
      });

      req.on('error', (e) => {
        resolve({ url: originalUrl, status: 0, ok: false, error: e.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ url: originalUrl, status: 0, ok: false, error: 'timeout' });
      });

      req.end();
    }

    followGet(originalUrl, redirectsLeft);
  });
}

/**
 * Check multiple URLs with concurrency limiting.
 *
 * @param {Array<{url: string, anchorText: string}>} urls - URLs to check
 * @returns {Promise<Array<{url: string, anchorText: string, status: number, ok: boolean, error?: string}>>}
 */
async function checkUrlsBatch(urls) {
  const results = [];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        const result = await checkUrl(item.url);
        return { ...item, ...result };
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ ...urls[i], status: 0, ok: false, error: r.reason?.message || 'unknown' });
      }
    }
  }

  return results;
}

/**
 * PUBLISHER MODE: Check all external links in article HTML and strip dead ones.
 * Returns the cleaned HTML with dead links converted to plain text,
 * plus a report of what was removed.
 *
 * @param {string} html - Article HTML content
 * @param {string} [siteDomain] - Own site domain to exclude from checking
 * @returns {Promise<{html: string, removed: Array<{url: string, anchorText: string, status: number, error?: string}>, checked: number, alive: number, dead: number}>}
 */
export async function checkAndStripDeadLinks(html, siteDomain = null) {
  const urls = extractExternalUrls(html, siteDomain);

  if (urls.length === 0) {
    return { html, removed: [], checked: 0, alive: 0, dead: 0 };
  }

  console.log(`[LinkChecker] Checking ${urls.length} external URLs...`);

  const results = await checkUrlsBatch(urls);
  const dead = results.filter(r => !r.ok);
  const alive = results.filter(r => r.ok);

  console.log(`[LinkChecker] Results: ${alive.length} alive, ${dead.length} dead out of ${results.length} checked`);

  // Strip dead links — convert <a href="dead">text</a> to just "text"
  let cleanedHtml = html;
  for (const d of dead) {
    // Escape special regex chars in URL
    const escapedUrl = d.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the full <a> tag with this URL and replace with just the inner text
    const linkRegex = new RegExp(`<a\\s[^>]*href="${escapedUrl}"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
    cleanedHtml = cleanedHtml.replace(linkRegex, '$1');
    console.log(`[LinkChecker] Stripped dead link (${d.status}${d.error ? ' ' + d.error : ''}): ${d.url}`);
  }

  return {
    html: cleanedHtml,
    removed: dead.map(d => ({ url: d.url, anchorText: d.anchorText, status: d.status, error: d.error })),
    checked: results.length,
    alive: alive.length,
    dead: dead.length,
  };
}

/**
 * QUALITY EDITOR MODE: Check all external links in article HTML and return status report.
 * Does NOT modify the HTML — just reports what's alive and what's dead.
 *
 * @param {string} html - Article HTML content
 * @param {string} [siteDomain] - Own site domain to exclude from checking
 * @returns {Promise<{results: Array<{url: string, anchorText: string, status: number, ok: boolean, error?: string}>, checked: number, alive: number, dead: number}>}
 */
export async function checkArticleLinks(html, siteDomain = null) {
  const urls = extractExternalUrls(html, siteDomain);

  if (urls.length === 0) {
    return { results: [], checked: 0, alive: 0, dead: 0 };
  }

  console.log(`[LinkChecker] Checking ${urls.length} external URLs...`);

  const results = await checkUrlsBatch(urls);
  const dead = results.filter(r => !r.ok);
  const alive = results.filter(r => r.ok);

  console.log(`[LinkChecker] Results: ${alive.length} alive, ${dead.length} dead out of ${results.length} checked`);

  return {
    results,
    checked: results.length,
    alive: alive.length,
    dead: dead.length,
  };
}

/**
 * Format link check results for the quality editor reviewer prompt.
 *
 * @param {Array<{url: string, anchorText: string, status: number, ok: boolean, error?: string}>} results
 * @returns {string}
 */
export function formatLinkCheckForReviewer(results) {
  if (!results || results.length === 0) {
    return '\nLINK CHECK: No external URLs found in article.\n';
  }

  const dead = results.filter(r => !r.ok);
  const alive = results.filter(r => r.ok);

  let block = `\nLINK CHECK RESULTS (${alive.length} alive, ${dead.length} dead out of ${results.length} checked):\n`;

  if (dead.length > 0) {
    block += '\nDEAD LINKS (confirmed via HTTP request):\n';
    for (const d of dead) {
      block += `- [${d.status || 'FAIL'}${d.error ? ' ' + d.error : ''}] ${d.url} (anchor: "${d.anchorText}")\n`;
    }
  }

  if (alive.length > 0) {
    block += '\nALIVE LINKS (confirmed via HTTP request):\n';
    for (const a of alive) {
      block += `- [${a.status}] ${a.url}\n`;
    }
  }

  return block;
}
