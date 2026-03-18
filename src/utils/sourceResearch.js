/**
 * ENHANCED SOURCE RESEARCH — Option C Hybrid Implementation
 *
 * Combines multiple source discovery strategies:
 * 1. Title-based claim extraction (existing Option B)
 * 2. Research brief extraction (new — uses real sources from publications we've read)
 * 3. Multi-search (Google News RSS + Bing News RSS) for high-confidence sourcing
 *
 * Uses Claude Haiku to extract key factual claims and research brief content,
 * then performs targeted searches for each claim via Google News and Bing News RSS.
 * Verifies all URLs are reachable before returning.
 */

import Anthropic from '@anthropic-ai/sdk';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SOURCES = 8;
const CURRENT_DATE = new Date().toISOString().split('T')[0];

// Aggregator domains to filter out — prefer primary sources over syndicated content
const AGGREGATOR_DOMAINS = [
  'msn.com',
  'news.yahoo.com',
  'news.google.com',
  'apple.news',
  'flipboard.com',
  'smartnews.com',
  'newsbreak.com',
  'ground.news',
  'upday.com',
];

let anthropicClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Extract the root domain key from a URL (e.g., "www.nature.com/articles/..." → "nature.com").
 */
function getDomainKey(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const parts = hostname.split('.');
    // Handle subdomains like pubmed.ncbi.nlm.nih.gov → nih.gov, news.bbc.co.uk → bbc.co.uk
    if (parts.length > 2 && (parts[parts.length - 1].length <= 3)) {
      return parts.slice(-3).join('.'); // e.g. bbc.co.uk
    }
    return parts.slice(-2).join('.'); // e.g. nature.com
  } catch {
    return url;
  }
}

/**
 * Research real source URLs for a given article title/topic.
 * Uses Haiku to extract specific claims, then searches for sources for each claim.
 * Returns verified, reachable URLs with titles and source names.
 *
 * @param {string} title - The article title to research sources for
 * @param {string} [siteDomain] - Domain to exclude (own site)
 * @returns {Promise<Array<{url: string, title: string, source: string, claim?: string}>>}
 */
export async function researchSources(title, siteDomain = null) {
  try {
    // STEP 1: Use Haiku to extract key claims needing sources
    const claims = await extractClaimsNeedingSources(title);
    console.log(`[SourceResearch] Identified ${claims.length} claims to source for: "${title.substring(0, 50)}..."`);

    // STEP 2: Search for each claim via BOTH Google News AND Bing News
    // Google News URLs often can't be resolved (protobuf encoding), so Bing is primary
    const allCandidates = [];
    const searchPromises = [];

    for (const claim of claims) {
      // Bing News (primary — returns resolvable URLs)
      searchPromises.push(
        searchBingNews(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description })))
          .catch(() => [])
      );
      // Google News (secondary — may fail to resolve URLs)
      searchPromises.push(
        searchGoogleNews(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description })))
          .catch(() => [])
      );
    }

    // Also search with original title terms as fallback
    const titleTerms = extractSearchTerms(title);
    if (titleTerms.trim().length > 0) {
      searchPromises.push(
        searchBingNews(titleTerms)
          .then(results => results.map(r => ({ ...r, claim: 'general' })))
          .catch(() => [])
      );
      searchPromises.push(
        searchGoogleNews(titleTerms)
          .then(results => results.map(r => ({ ...r, claim: 'general' })))
          .catch(() => [])
      );
    }

    const searchResults = await Promise.allSettled(searchPromises);
    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        allCandidates.push(...result.value);
      }
    }

    console.log(`[SourceResearch] Total candidates before dedup: ${allCandidates.length}`);

    // Deduplicate by URL
    const uniqueCandidates = deduplicateByUrl(allCandidates);

    // Filter out aggregator domains — prefer primary sources
    let filtered = uniqueCandidates.filter(item => {
      try {
        const hostname = new URL(item.url).hostname.replace('www.', '');
        return !AGGREGATOR_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
      } catch { return true; }
    });

    // Filter out own domain
    if (siteDomain) {
      filtered = filtered.filter(r => !r.url.includes(siteDomain));
    }

    console.log(`[SourceResearch] Candidates after filtering: ${filtered.length} (from ${uniqueCandidates.length} unique)`);

    // STEP 3: Verify URLs are reachable
    const verified = await verifyUrls(filtered.slice(0, MAX_SOURCES + 5));

    const sources = verified.slice(0, MAX_SOURCES);
    console.log(`[SourceResearch] Found ${sources.length} verified sources`);

    return sources;
  } catch (e) {
    console.warn(`[SourceResearch] Failed to research sources: ${e.message}`);
    return [];
  }
}

/**
 * Use Claude Haiku to extract 3-5 key factual claims from the article title.
 * Returns array of { description, searchQuery } objects.
 * Includes current date awareness in the prompt.
 */
async function extractClaimsNeedingSources(title) {
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Today's date is ${CURRENT_DATE}. Given this article title, identify 3-5 specific factual claims or research findings that would need sourcing. For each, provide a targeted Google News search query that would find the real source.

Title: "${title}"

Return JSON array (no markdown, no backticks):
[{"description": "what needs sourcing", "searchQuery": "specific search terms to find this source"}]

Focus on: specific studies, statistics, institutional reports, named researchers, policy documents, company earnings/data. Make search queries specific and targeted. Example search queries: "Stanford study social media depression 2024", "WHO mental health statistics 2024", "Tesla earnings Q4 2024".

CRITICAL: The source must contain the SPECIFIC study, statistic, or research finding being cited. Topical overlap alone is NOT sufficient — the article must directly support the exact claim. If the source only discusses the same broad topic without containing the specific evidence, reject it.

If the title doesn't contain specific factual claims (e.g., opinion pieces), return an empty array [].`
      }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (e) {
    console.warn(`[SourceResearch] Claim extraction failed: ${e.message}`);
    return [];
  }
}

/**
 * Extract meaningful search terms from a title (fallback when claims are empty).
 * Removes common filler words and keeps the substantive parts.
 */
function extractSearchTerms(title) {
  const cleaned = title
    .replace(/[''""\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s*[—–-]\s*/g, ' ')
    .replace(/\b(the|a|an|is|are|was|were|has|have|had|and|or|but|for|in|on|at|to|of|with|by|from|its|it|that|this|these|those|how|why|what|when|where|who|your|you|my|our|their|here|just|also|still|even|yet|now|new)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2).slice(0, 8);
  return words.join(' ');
}

/**
 * Search Google News RSS for articles matching a query.
 */
async function searchGoogleNews(query) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const xml = await new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', (e) => {
      console.warn(`[SourceResearch] Google News request failed: ${e.message}`);
      resolve('');
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });

  if (!xml) return [];

  try {
    return await parseRssResults(xml);
  } catch (e) {
    console.warn(`[SourceResearch] Failed to parse Google News RSS: ${e.message}`);
    return [];
  }
}

/**
 * Deduplicate candidates by URL.
 */
function deduplicateByUrl(candidates) {
  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.url)) {
      return false;
    }
    seen.add(c.url);
    return true;
  });
}

/**
 * Attempt to decode a Google News redirect URL to extract the real destination URL.
 * Tries multiple decoding strategies for different Google News URL formats.
 */
function tryDecodeGoogleNewsUrl(url) {
  try {
    // Match both /rss/articles/ and /articles/ paths
    const articlesMatch = url.match(/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/);
    if (articlesMatch) {
      const encoded = articlesMatch[1];

      // Strategy 1: Standard base64 decode
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const urlMatch = decoded.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/);
        if (urlMatch && !urlMatch[0].includes('news.google.com')) {
          const cleanUrl = urlMatch[0].replace(/[\x00-\x1f]/g, '');
          console.log(`[SourceResearch] Decoded Google News URL (base64): ${cleanUrl.substring(0, 80)}...`);
          return cleanUrl;
        }
      } catch (e) { /* base64 decode failed, try next strategy */ }

      // Strategy 2: URL-safe base64 (replace - with + and _ with /)
      try {
        const urlSafe = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const padded = urlSafe + '='.repeat((4 - urlSafe.length % 4) % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        const urlMatch = decoded.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/);
        if (urlMatch && !urlMatch[0].includes('news.google.com')) {
          const cleanUrl = urlMatch[0].replace(/[\x00-\x1f]/g, '');
          console.log(`[SourceResearch] Decoded Google News URL (url-safe base64): ${cleanUrl.substring(0, 80)}...`);
          return cleanUrl;
        }
      } catch (e) { /* url-safe base64 also failed */ }

      // Strategy 3: Try decoding just the part after CBMi prefix (protobuf-like encoding)
      try {
        if (encoded.startsWith('CBMi') || encoded.startsWith('CBMI')) {
          // Skip first 4 chars (CBMi) which is a protobuf field header
          const payload = encoded.substring(4);
          const decoded = Buffer.from(payload, 'base64').toString('utf-8');
          const urlMatch = decoded.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/);
          if (urlMatch && !urlMatch[0].includes('news.google.com')) {
            const cleanUrl = urlMatch[0].replace(/[\x00-\x1f]/g, '');
            console.log(`[SourceResearch] Decoded Google News URL (CBMi strip): ${cleanUrl.substring(0, 80)}...`);
            return cleanUrl;
          }
        }
      } catch (e) { /* CBMi strip failed */ }
    }
  } catch (e) {
    // All decoding failed — that's OK, we'll fall back to HTTP redirect follow
  }
  return null;
}

/**
 * Follow a Google News redirect URL via HTTP to resolve the real destination URL.
 * Makes a HEAD request and follows redirects to find the final URL.
 */
function followGoogleNewsRedirect(googleUrl) {
  return new Promise((resolve) => {
    const maxRedirects = 5;
    let currentUrl = googleUrl;
    let redirectCount = 0;

    function followNext(url) {
      if (redirectCount >= maxRedirects) {
        resolve(null);
        return;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        resolve(null);
        return;
      }

      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.request(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        // Consume response body to free up the socket
        res.resume();

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          let redirectUrl;
          try {
            redirectUrl = new URL(res.headers.location, url).toString();
          } catch {
            resolve(null);
            return;
          }

          // If we've left Google News domain, we have our target
          if (!redirectUrl.includes('news.google.com') && !redirectUrl.includes('google.com/rss')) {
            console.log(`[SourceResearch] Resolved Google News redirect → ${redirectUrl.substring(0, 80)}...`);
            resolve(redirectUrl);
          } else {
            followNext(redirectUrl);
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          // Google News sometimes returns a page with a meta refresh or JS redirect
          // Check if the final URL is no longer a google URL
          if (!url.includes('news.google.com')) {
            resolve(url);
          } else {
            // Read body to find meta refresh URL
            let body = '';
            // We already called res.resume(), so re-listen won't work
            // For 200 on news.google.com, it means redirect didn't happen via headers
            // Try extracting from the URL itself as last resort
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    }

    followNext(currentUrl);
  });
}

/**
 * Parse RSS XML to extract article URLs, titles, and sources.
 * Returns items with resolved URLs. Google News redirect URLs are decoded
 * client-side first, then resolved via HTTP redirect as fallback.
 */
async function parseRssResults(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);

    if (linkMatch) {
      const title = (titleMatch?.[1] || titleMatch?.[2] || '').trim();
      const url = linkMatch[1].trim();
      const source = (sourceMatch?.[1] || '').trim();
      // Extract source domain URL from <source url="..."> attribute
      const sourceUrlMatch = item.match(/<source\s+url="([^"]+)"/);
      const sourceDomainUrl = sourceUrlMatch?.[1] || '';

      if (url) {
        items.push({ url, title, source, sourceDomainUrl });
      }
    }
  }

  // Resolve Bing News redirect URLs (fast, no network — extract url= parameter)
  for (let i = 0; i < items.length; i++) {
    if (items[i].url.includes('bing.com/news/apiclick.aspx')) {
      try {
        const bingUrl = new URL(items[i].url);
        const realUrl = bingUrl.searchParams.get('url');
        if (realUrl && !realUrl.includes('bing.com')) {
          console.log(`[SourceResearch] Resolved Bing redirect → ${realUrl.substring(0, 80)}...`);
          items[i] = { ...items[i], url: realUrl };
        }
      } catch { /* leave as-is if URL parsing fails */ }
    }
  }

  // Resolve Google News redirect URLs in parallel
  let googleUnresolved = 0;
  const resolvedResults = await Promise.allSettled(
    items.map(async (item) => {
      if (!item.url.includes('news.google.com')) {
        return item; // Already a direct URL (e.g. Bing results)
      }

      // Strategy A: Try client-side base64 decode first (fast, no network)
      const decodedUrl = tryDecodeGoogleNewsUrl(item.url);
      if (decodedUrl) {
        return { ...item, url: decodedUrl };
      }

      // Strategy B: Follow the redirect via HTTP
      const resolvedUrl = await followGoogleNewsRedirect(item.url);
      if (resolvedUrl && !resolvedUrl.includes('news.google.com')) {
        return { ...item, url: resolvedUrl };
      }

      // Strategy C: Use source domain + title to search Bing for the actual article
      // Google News includes <source url="https://www.reuters.com"> — we can search that domain
      if (item.sourceDomainUrl && item.title) {
        try {
          const domain = new URL(item.sourceDomainUrl).hostname.replace('www.', '');
          const searchTitle = item.title.replace(/ - .*$/, '').trim(); // Remove " - Source Name" suffix
          const bingResults = await searchBingNews(`site:${domain} ${searchTitle.substring(0, 80)}`);
          if (bingResults.length > 0) {
            const match = bingResults.find(r => !r.url.includes('bing.com') && !r.url.includes('news.google.com'));
            if (match) {
              console.log(`[SourceResearch] Resolved via Bing site search: ${match.url.substring(0, 80)}...`);
              return { ...item, url: match.url };
            }
          }
        } catch { /* site search fallback failed */ }
      }

      googleUnresolved++;
      return null; // Couldn't resolve — skip this one
    })
  );

  if (googleUnresolved > 0) {
    console.log(`[SourceResearch] ${googleUnresolved} Google News URLs could not be resolved (protobuf encoding)`);
  }

  return resolvedResults
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

/**
 * Verify that URLs are reachable (GET request, follow redirects).
 */
async function verifyUrls(candidates) {
  const results = await Promise.allSettled(
    candidates.map(c => verifyOneUrl(c))
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .filter(r => !r.url.includes('news.google.com'));
}

/**
 * Verify a single URL is reachable and fetch a content snippet.
 * Follows HTTP redirects and returns the FINAL resolved URL + content preview.
 */
function verifyOneUrl(candidate, redirectsLeft = 5) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(candidate.url);
    } catch {
      resolve(null);
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(candidate.url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location, candidate.url).toString();
        } catch {
          resolve(null);
          return;
        }
        verifyOneUrl({ ...candidate, url: redirectUrl }, redirectsLeft - 1)
          .then(resolve);
        return;
      }

      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Fetch body content for snippet extraction
        let body = '';
        const maxBytes = 50000; // Read up to 50KB for content extraction
        let bytesRead = 0;

        res.on('data', (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead <= maxBytes) {
            body += chunk.toString();
          }
        });

        res.on('end', () => {
          // Extract text content from HTML
          let contentSnippet = '';
          try {
            // Remove scripts, styles, nav, footer
            let cleaned = body
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '');
            // Extract text from paragraph tags
            const paragraphs = [];
            const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
            let pMatch;
            while ((pMatch = pRegex.exec(cleaned)) !== null) {
              const text = pMatch[1].replace(/<[^>]+>/g, '').trim();
              if (text.length > 40) paragraphs.push(text);
            }
            contentSnippet = paragraphs.slice(0, 5).join(' ').substring(0, 500);
          } catch {
            // Content extraction failed — still return the verified URL
          }

          resolve({
            url: candidate.url,
            title: candidate.title,
            source: candidate.source,
            claim: candidate.claim,
            contentSnippet: contentSnippet || '',
          });
        });

        res.on('error', () => {
          resolve({
            url: candidate.url,
            title: candidate.title,
            source: candidate.source,
            claim: candidate.claim,
            contentSnippet: '',
          });
        });
      } else {
        res.resume();
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Format verified sources into a string block for the article writing prompt.
 * Shows which claim each source supports.
 */
export function formatSourcesForPrompt(sources) {
  if (!sources || sources.length === 0) {
    return '\nVERIFIED SOURCES:\nNo verified external sources found. Reference studies/publications by name only — do NOT create any external hyperlinks. Do NOT fabricate URLs.\n';
  }

  let block = '\nVERIFIED SOURCES (use ONLY these URLs for external links — do NOT invent any other URLs):\n';
  for (const s of sources) {
    block += `- "${s.title}" (${s.source}) — ${s.url}`;
    if (s.contentSnippet) {
      block += `\n  Content preview: ${s.contentSnippet}`;
    }
    if (s.claim && s.claim !== 'general') {
      block += ` [supports: ${s.claim}]`;
    }
    block += '\n';
  }
  block += '\nRULES:\n- ONLY use URLs from the list above for hyperlinks\n- If a claim cannot be supported by these sources, mention the finding by name WITHOUT a hyperlink\n- NEVER fabricate, guess, or invent URLs\n- Aim for 4-6 properly hyperlinked source references throughout the article\n';

  return block;
}

/**
 * OPTION C HYBRID: Research sources from both a research brief (real sources from publications)
 * AND title-based searches (Google News + Bing News).
 *
 * This function:
 * 1. Extracts URLs from the research brief (sources we've already read)
 * 2. Extracts claims from the title and searches for them
 * 3. Searches Bing News for additional coverage
 * 4. Verifies all URLs are reachable
 * 5. Deduplicates and returns combined results
 *
 * @param {string} researchBrief - Content from publication monitor (may be empty)
 * @param {string} title - The article title to research sources for
 * @param {string} [siteDomain] - Domain to exclude (own site)
 * @returns {Promise<Array<{url: string, title: string, sourceName: string, claim?: string, verified: boolean}>>}
 */
export async function researchSourcesFromBrief(researchBrief, title, siteDomain = null) {
  try {
    const allCandidates = [];

    // STRATEGY 1: Extract sources directly from research brief (if provided)
    if (researchBrief && researchBrief.trim().length > 0) {
      const briefSources = extractSourcesFromBrief(researchBrief);
      console.log(`[SourceResearch] Extracted ${briefSources.length} sources from research brief`);
      allCandidates.push(...briefSources);
    }

    // STRATEGY 2: Extract claims from title and search for them
    const claims = await extractClaimsNeedingSources(title);
    console.log(`[SourceResearch] Identified ${claims.length} claims to source from title: "${title.substring(0, 50)}..."`);

    const searchPromises = [];

    // Search Google News for each claim
    for (const claim of claims) {
      searchPromises.push(
        searchGoogleNews(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description, sourceName: r.source || 'Google News' })))
      );

      // Also search Bing News for the same claim
      searchPromises.push(
        searchBingNews(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description, sourceName: r.source || 'Bing News' })))
      );
    }

    // Also search with original title terms as fallback
    const titleTerms = extractSearchTerms(title);
    if (titleTerms.trim().length > 0) {
      searchPromises.push(
        searchGoogleNews(titleTerms)
          .then(results => results.map(r => ({ ...r, claim: 'general', sourceName: r.source || 'Google News' })))
      );
      searchPromises.push(
        searchBingNews(titleTerms)
          .then(results => results.map(r => ({ ...r, claim: 'general', sourceName: r.source || 'Bing News' })))
      );
    }

    const searchResults = await Promise.allSettled(searchPromises);
    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        allCandidates.push(...result.value);
      }
    }

    // Deduplicate by URL
    const uniqueCandidates = deduplicateByUrl(allCandidates);

    // Filter out own domain
    let filtered = uniqueCandidates;
    if (siteDomain) {
      filtered = filtered.filter(r => !r.url.includes(siteDomain));
    }

    // STEP 2b: Primary source prioritization — boost academic/journal/institutional sources
    // These are often the REAL source behind news coverage (Nature, Science, WHO, etc.)
    const PRIMARY_SOURCE_DOMAINS = new Set([
      'nature.com', 'science.org', 'sciencedirect.com', 'pnas.org', 'cell.com',
      'thelancet.com', 'bmj.com', 'nejm.org', 'jamanetwork.com', 'apa.org',
      'who.int', 'cdc.gov', 'nih.gov', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
      'arxiv.org', 'ssrn.com', 'nber.org', 'worldbank.org', 'imf.org',
      'pewresearch.org', 'gallup.com', 'brookings.edu', 'rand.org',
      'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk',
      'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'economist.com', 'ft.com',
    ]);

    // Sort: primary/institutional sources first, then brief sources, then search results
    filtered.sort((a, b) => {
      const aDomain = getDomainKey(a.url);
      const bDomain = getDomainKey(b.url);
      const aPrimary = PRIMARY_SOURCE_DOMAINS.has(aDomain) ? 1 : 0;
      const bPrimary = PRIMARY_SOURCE_DOMAINS.has(bDomain) ? 1 : 0;
      if (aPrimary !== bPrimary) return bPrimary - aPrimary; // primary first
      // Then brief sources before search results
      const aBrief = (a.sourceName === 'Research Brief' || a.type === 'secondary' || a.type === 'cited') ? 1 : 0;
      const bBrief = (b.sourceName === 'Research Brief' || b.type === 'secondary' || b.type === 'cited') ? 1 : 0;
      return bBrief - aBrief;
    });

    // STEP 2c: Domain diversity cap — max 2 sources from any single domain
    const MAX_PER_DOMAIN = 2;
    const domainCounts = {};
    const diverse = [];
    const overflow = [];
    for (const candidate of filtered) {
      const domainKey = getDomainKey(candidate.url);
      domainCounts[domainKey] = (domainCounts[domainKey] || 0) + 1;
      if (domainCounts[domainKey] <= MAX_PER_DOMAIN) {
        diverse.push(candidate);
      } else {
        overflow.push(candidate);
      }
    }
    filtered = [...diverse, ...overflow];
    const cappedDomains = Object.entries(domainCounts).filter(([, c]) => c > MAX_PER_DOMAIN);
    if (cappedDomains.length > 0) {
      console.log(`[SourceResearch] Domain diversity: capped ${cappedDomains.map(([d, c]) => `${d}(${c})`).join(', ')} to max ${MAX_PER_DOMAIN} each`);
    }

    // STEP 3: Verify URLs are reachable
    const verified = await verifyUrls(filtered.slice(0, MAX_SOURCES + 5));

    const sources = verified.slice(0, MAX_SOURCES);
    console.log(`[SourceResearch] Found ${sources.length} verified sources (hybrid method)`);

    return sources;
  } catch (e) {
    console.warn(`[SourceResearch] Failed to research sources (hybrid): ${e.message}`);
    return [];
  }
}

/**
 * Extract source URLs and claims directly from research brief text.
 * Looks for URLs and attempts to extract context about what they support.
 * Falls back gracefully if no URLs found.
 *
 * @param {string} researchBrief - Content from publication monitor
 * @returns {Array<{url: string, title: string, claim?: string}>}
 */
function extractSourcesFromBrief(researchBrief) {
  const sources = [];

  if (!researchBrief || researchBrief.trim().length === 0) {
    return sources;
  }

  // Match URLs in the brief (both http/https)
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const urlMatches = researchBrief.match(urlRegex) || [];

  // Remove duplicates
  const uniqueUrls = [...new Set(urlMatches)];

  for (const url of uniqueUrls) {
    try {
      new URL(url); // Validate URL
      sources.push({
        url,
        title: extractTitleFromUrl(url),
        claim: 'research brief',
        sourceName: 'Research Brief',
      });
    } catch (e) {
      // Invalid URL, skip
    }
  }

  console.log(`[SourceResearch] Extracted ${sources.length} URLs from research brief`);
  return sources;
}

/**
 * Extract a reasonable title from a URL (domain + last path segment).
 */
function extractTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    let title = parsed.hostname.replace('www.', '');

    // Get last meaningful path segment
    const pathSegments = parsed.pathname.split('/').filter(s => s.length > 0);
    if (pathSegments.length > 0) {
      const lastSegment = pathSegments[pathSegments.length - 1];
      const cleaned = lastSegment
        .replace(/[-_]/g, ' ')
        .replace(/\.html?$/i, '')
        .substring(0, 60);
      if (cleaned.length > 2) {
        title = cleaned;
      }
    }

    return title;
  } catch {
    return url.substring(0, 60);
  }
}

/**
 * Search Bing News RSS for articles matching a query.
 * Complements Google News with additional source diversity.
 */
async function searchBingNews(query) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/news/search?q=${encoded}&format=rss`;

  const xml = await new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', (e) => {
      console.warn(`[SourceResearch] Bing News request failed: ${e.message}`);
      resolve('');
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });

  if (!xml) return [];

  try {
    return await parseRssResults(xml);
  } catch (e) {
    console.warn(`[SourceResearch] Failed to parse Bing News RSS: ${e.message}`);
    return [];
  }
}

/**
 * Format verified sources (hybrid method) into a structured block for the article writing prompt.
 * Separates "PRIMARY SOURCES (from publications we've read)" from "ADDITIONAL SOURCES (found via search)".
 * Includes relevant context from the research brief.
 *
 * @param {Array<{url: string, title: string, sourceName: string, claim?: string}>} sources - Verified sources
 * @param {string} researchBrief - The original research brief (for context)
 * @returns {string} Formatted block for the writing prompt
 */
export function formatEnhancedSourcesForPrompt(sources, researchBrief) {
  if (!sources || sources.length === 0) {
    return '\nVERIFIED SOURCES:\nNo verified external sources found. Reference studies/publications by name only — do NOT create any external hyperlinks. Do NOT fabricate URLs.\n';
  }

  // Separate primary (from brief) and additional (from search)
  const primarySources = sources.filter(s => s.sourceName === 'Research Brief' || s.claim === 'research brief');
  const additionalSources = sources.filter(s => s.sourceName !== 'Research Brief' && s.claim !== 'research brief');

  let block = '\nVERIFIED SOURCES (use ONLY these URLs for external links — do NOT invent any other URLs):\n';

  if (primarySources.length > 0) {
    block += '\nPRIMARY SOURCES (from publications we\'ve read):\n';
    for (const s of primarySources) {
      block += `- "${s.title}" (${s.sourceName}) — ${s.url}`;
      if (s.contentSnippet) {
        block += `\n  Content preview: ${s.contentSnippet}`;
      }
      block += '\n';
    }
  }

  if (additionalSources.length > 0) {
    block += '\nADDITIONAL SOURCES (found via search):\n';
    for (const s of additionalSources) {
      block += `- "${s.title}" (${s.sourceName})`;
      if (s.claim && s.claim !== 'general' && s.claim !== 'research brief') {
        block += ` [supports: ${s.claim}]`;
      }
      block += ` — ${s.url}`;
      if (s.contentSnippet) {
        block += `\n  Content preview: ${s.contentSnippet}`;
      }
      block += '\n';
    }
  }

  block += '\nRULES:\n';
  block += '- ONLY use URLs from the list above for hyperlinks\n';
  block += '- Primary sources (from our research brief) have higher credibility — prefer them when possible\n';
  block += '- If a claim cannot be supported by these sources, mention the finding by name WITHOUT a hyperlink\n';
  block += '- NEVER fabricate, guess, or invent URLs\n';
  block += '- Aim for 4-6 properly hyperlinked source references throughout the article\n';

  if (researchBrief && researchBrief.trim().length > 0) {
    block += '\nRESEARCH BRIEF CONTEXT:\n';
    block += researchBrief.substring(0, 4000) + (researchBrief.length > 4000 ? '...' : '') + '\n';
  }

  return block;
}
