/**
 * WEB SOURCE RESEARCH — For psychology/lifestyle content
 *
 * Unlike sourceResearch.js (which searches NEWS RSS feeds for breaking news sources),
 * this module searches the broader web for authoritative, evergreen sources suitable
 * for psychology, lifestyle, self-improvement, and wellness content.
 *
 * Strategy:
 * 1. Claude Haiku extracts research claims/concepts from the title
 * 2. Generates targeted search queries for each claim
 * 3. Searches multiple reliable sources that work from server IPs:
 *    - PubMed API (academic papers — no auth, no CAPTCHA, free)
 *    - Bing News RSS (psychology articles in media — reliable RSS feed)
 *    - Google News RSS (additional news coverage)
 * 4. Prioritizes authoritative domains (.edu, .gov, NIH, APA, WHO, etc.)
 * 5. Verifies URLs are reachable and extracts content snippets
 * 6. Returns formatted sources block for the writing prompt
 *
 * NOTE: Bing Web HTML scraping and DuckDuckGo HTML both return CAPTCHAs
 * from server/cloud IPs. We use only API endpoints and RSS feeds that
 * reliably work without authentication or bot detection.
 *
 * Used by: SC psychology tier, SC adjacent tier, DMN psychology lanes,
 *          juzzy-bot/ruda-bot/jcb-bot for lifestyle articles
 */

import Anthropic from '@anthropic-ai/sdk';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SOURCES = 6;

// Authoritative domains for psychology/lifestyle content — get priority scoring
const AUTHORITY_DOMAINS = [
  // Academic & Research
  'nih.gov', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'nature.com',
  'sciencedirect.com', 'springer.com', 'wiley.com', 'jstor.org',
  'frontiersin.org', 'plos.org', 'bmj.com', 'thelancet.com',
  // Psychology-specific
  'apa.org', 'psychologytoday.com', 'sciencedaily.com',
  'psychcentral.com', 'verywellmind.com',
  // Health & Wellness
  'who.int', 'cdc.gov', 'mayoclinic.org', 'clevelandclinic.org',
  'health.harvard.edu', 'hopkinsmedicine.org', 'webmd.com',
  'healthline.com', 'medicalnewstoday.com',
  // General authority
  'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com',
  'theatlantic.com', 'newyorker.com', 'scientificamerican.com',
  'ted.com', 'hbr.org',
];

// Domains to never include as sources
const BLOCKED_DOMAINS = [
  'pinterest.com', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'tiktok.com', 'reddit.com', 'quora.com',
  'youtube.com', 'amazon.com', 'ebay.com',
];

let anthropicClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Research authoritative web sources for a psychology/lifestyle article title.
 *
 * @param {string} title - The article title to research sources for
 * @param {string} [siteDomain] - Domain to exclude (own site)
 * @returns {Promise<Array<{url: string, title: string, source: string, claim: string, contentSnippet: string, authorityScore: number}>>}
 */
export async function researchWebSources(title, siteDomain = null) {
  try {
    // STEP 1: Extract research concepts and claims from the title
    const claims = await extractResearchClaims(title);
    console.log(`[WebSourceResearch] Identified ${claims.length} research claims for: "${title.substring(0, 60)}..."`);

    if (claims.length === 0) {
      console.log(`[WebSourceResearch] No research claims found — title may be purely opinion-based`);
      return [];
    }

    // STEP 2: Search using reliable methods (PubMed API + Bing News RSS + Google News RSS)
    const allCandidates = [];
    const searchPromises = [];

    for (const claim of claims) {
      // PRIMARY: PubMed API — academic papers, always works, no CAPTCHA
      searchPromises.push(
        searchPubMed(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description })))
          .catch(() => [])
      );

      // SECONDARY: Bing News RSS — psychology articles in mainstream media
      searchPromises.push(
        searchBingNewsRss(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description })))
          .catch(() => [])
      );

      // TERTIARY: Google News RSS
      searchPromises.push(
        searchGoogleNewsRss(claim.searchQuery)
          .then(results => results.map(r => ({ ...r, claim: claim.description })))
          .catch(() => [])
      );
    }

    // FALLBACK: Broad searches with title keywords
    const titleTerms = extractSearchTerms(title);
    if (titleTerms.trim().length > 0) {
      // PubMed with title keywords
      searchPromises.push(
        searchPubMed(titleTerms)
          .then(results => results.map(r => ({ ...r, claim: 'general' })))
          .catch(() => [])
      );

      // Bing News with title keywords + psychology qualifier
      searchPromises.push(
        searchBingNewsRss(titleTerms + ' psychology research')
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

    console.log(`[WebSourceResearch] Total candidates before dedup: ${allCandidates.length}`);

    // STEP 3: Deduplicate, filter, and score
    const unique = deduplicateByUrl(allCandidates);

    // Filter out blocked domains and own domain
    let filtered = unique.filter(r => {
      try {
        const hostname = new URL(r.url).hostname.replace('www.', '');
        if (BLOCKED_DOMAINS.some(d => hostname.includes(d))) return false;
        if (siteDomain && hostname.includes(siteDomain)) return false;
        return true;
      } catch { return false; }
    });

    // Score by authority
    filtered = filtered.map(r => ({
      ...r,
      authorityScore: scoreAuthority(r.url),
    }));

    // Sort by authority score (higher = better)
    filtered.sort((a, b) => b.authorityScore - a.authorityScore);

    // STEP 3b: Enforce domain diversity — max 2 sources from any single domain
    // This prevents Psychology Today (or any one source) from dominating
    const MAX_PER_DOMAIN = 2;
    const domainCounts = {};
    const diverse = [];
    const overflow = []; // Sources that exceed the per-domain cap
    for (const candidate of filtered) {
      try {
        const hostname = new URL(candidate.url).hostname.replace('www.', '');
        const domainKey = hostname.split('.').slice(-2).join('.'); // e.g. "psychologytoday.com"
        domainCounts[domainKey] = (domainCounts[domainKey] || 0) + 1;
        if (domainCounts[domainKey] <= MAX_PER_DOMAIN) {
          diverse.push(candidate);
        } else {
          overflow.push(candidate);
        }
      } catch {
        diverse.push(candidate); // Keep if URL parse fails
      }
    }
    // Append overflow at the end as fallbacks (in case we don't have enough diverse sources)
    filtered = [...diverse, ...overflow];

    console.log(`[WebSourceResearch] Candidates after filtering/scoring/diversity: ${filtered.length} (${diverse.length} diverse)`);

    // STEP 4: Verify URLs are reachable
    const verified = await verifyUrls(filtered.slice(0, MAX_SOURCES + 5));

    const sources = verified.slice(0, MAX_SOURCES);
    console.log(`[WebSourceResearch] Found ${sources.length} verified authoritative sources`);

    return sources;
  } catch (e) {
    console.warn(`[WebSourceResearch] Failed to research web sources: ${e.message}`);
    return [];
  }
}

/**
 * Use Claude Haiku to extract research concepts and claims from a psychology/lifestyle title.
 * Returns claims with targeted search queries.
 */
async function extractResearchClaims(title) {
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Analyze this psychology/lifestyle article title and identify 3-5 specific research claims, psychological concepts, or scientific findings that would benefit from authoritative sourcing.

Title: "${title}"

For each claim, provide:
1. A description of what needs sourcing
2. A concise search query (3-6 words) suitable for PubMed or news search

Focus on:
- Named psychological theories or concepts (attachment theory, cognitive dissonance, etc.)
- Research findings or statistics (studies show X%, research indicates, etc.)
- Health/wellness claims that need medical backing
- Named researchers or specific institutions
- Behavioral science claims
- Implied authority ("psychologists say", "research shows", "studies find", "experts explain")

Do NOT extract:
- Common knowledge that doesn't need sourcing
- Opinion/editorial framing
- Metaphorical language

Return JSON array (no markdown, no backticks):
[{"description": "what needs sourcing", "searchQuery": "concise search terms"}]

If the title is purely opinion/observational with no specific claims, return [].`
      }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (e) {
    console.warn(`[WebSourceResearch] Research claim extraction failed: ${e.message}`);
    return [];
  }
}

/**
 * Search PubMed for academic papers.
 * Uses NCBI's free E-utilities API — no API key needed, no CAPTCHA.
 * Rate limit: 3 requests/second without API key, 10/second with.
 */
async function searchPubMed(query) {
  if (!query || query.trim().length === 0) return [];

  const encoded = encodeURIComponent(query);

  // Step 1: Search for article IDs
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmax=5&retmode=json&term=${encoded}`;

  const searchJson = await fetchJson(searchUrl);
  if (!searchJson) return [];

  const ids = searchJson?.esearchresult?.idlist || [];
  if (ids.length === 0) return [];

  // Brief delay to respect PubMed rate limits
  await new Promise(r => setTimeout(r, 350));

  // Step 2: Get article summaries
  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`;

  const summaryJson = await fetchJson(summaryUrl);
  if (!summaryJson) return [];

  const result = summaryJson?.result || {};
  const articles = [];

  for (const uid of (result.uids || [])) {
    const article = result[uid];
    if (!article) continue;

    const articleTitle = article.title || '';
    const journal = article.source || '';
    const pubDate = article.pubdate || '';
    const authors = (article.authors || []).map(a => a.name).slice(0, 3).join(', ');

    articles.push({
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      title: articleTitle.replace(/<[^>]+>/g, '').trim(),
      source: 'pubmed.ncbi.nlm.nih.gov',
      contentSnippet: `${journal} (${pubDate}). Authors: ${authors}`,
    });
  }

  return articles;
}

/**
 * Search Bing News RSS — works reliably from server IPs (no CAPTCHA).
 * Good for psychology/wellness articles that appear in news media.
 */
async function searchBingNewsRss(query) {
  if (!query || query.trim().length === 0) return [];

  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/news/search?q=${encoded}&format=rss`;

  const xml = await fetchText(url);
  if (!xml) return [];

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
    const item = match[1];
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const descMatch = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);

    if (linkMatch && linkMatch[1]) {
      let rawUrl = linkMatch[1].trim();

      // Extract real URL from Bing redirect
      const urlParamMatch = rawUrl.match(/url=([^&]+)/);
      if (urlParamMatch) {
        try {
          rawUrl = decodeURIComponent(urlParamMatch[1]);
        } catch { /* use original */ }
      }

      const articleTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const snippet = descMatch ? descMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';

      try {
        const hostname = new URL(rawUrl).hostname.replace('www.', '');
        items.push({
          url: rawUrl,
          title: articleTitle || hostname,
          source: hostname,
          contentSnippet: snippet.substring(0, 300),
        });
      } catch { /* skip invalid URLs */ }
    }
  }

  return items;
}

/**
 * Search Google News RSS as an additional source.
 */
async function searchGoogleNewsRss(query) {
  if (!query || query.trim().length === 0) return [];

  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const xml = await fetchText(url);
  if (!xml) return [];

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
    const item = match[1];
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const sourceMatch = item.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);

    if (linkMatch && linkMatch[1]) {
      const articleTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      const rawLink = linkMatch[1].trim();

      // Google News RSS links redirect through Google — try to get source URL
      if (sourceMatch && sourceMatch[1]) {
        try {
          const sourceHostname = new URL(sourceMatch[1]).hostname.replace('www.', '');
          const sourceName = sourceMatch[2] ? sourceMatch[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : sourceHostname;

          items.push({
            url: rawLink, // Google redirect — will be followed during verification
            title: articleTitle || sourceName,
            source: sourceHostname,
            contentSnippet: `Via ${sourceName}`,
          });
        } catch { /* skip */ }
      }
    }
  }

  return items;
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Fetch JSON from a URL.
 */
function fetchJson(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch text content from a URL.
 */
function fetchText(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

/**
 * Score a URL by how authoritative its domain is for psychology/lifestyle content.
 */
function scoreAuthority(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');

    // .edu and .gov get highest scores
    if (hostname.endsWith('.edu')) return 10;
    if (hostname.endsWith('.gov')) return 9;

    // Check against authority list
    for (const domain of AUTHORITY_DOMAINS) {
      if (hostname.includes(domain)) return 8;
    }

    // Known good but not top-tier
    if (hostname.endsWith('.org')) return 5;
    if (hostname.endsWith('.ac.uk')) return 7;

    return 1; // Unknown domain
  } catch {
    return 0;
  }
}

/**
 * Extract meaningful search terms from a title.
 */
function extractSearchTerms(title) {
  const cleaned = title
    .replace(/['""\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s*[—–-]\s*/g, ' ')
    .replace(/\b(the|a|an|is|are|was|were|has|have|had|and|or|but|for|in|on|at|to|of|with|by|from|its|it|that|this|these|those|how|why|what|when|where|who|your|you|my|our|their|here|just|also|still|even|yet|now|new|really|actually|probably|things|people|many|most|some|psychologists|explain|research|shows|studies|find|experts|say|according|scientists)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.split(' ').filter(w => w.length > 2).slice(0, 6).join(' ');
}

/**
 * Deduplicate candidates by URL.
 */
function deduplicateByUrl(candidates) {
  const seen = new Set();
  return candidates.filter(c => {
    let normalized;
    try {
      const u = new URL(c.url);
      normalized = u.hostname + u.pathname.replace(/\/$/, '');
    } catch {
      normalized = c.url;
    }
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Verify that URLs are reachable.
 */
async function verifyUrls(candidates) {
  const results = await Promise.allSettled(
    candidates.map(c => verifyOneUrl(c))
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

/**
 * Verify a single URL is reachable, following redirects.
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
        verifyOneUrl({ ...candidate, url: redirectUrl }, redirectsLeft - 1).then(resolve);
        return;
      }

      if (res.statusCode >= 200 && res.statusCode < 300) {
        let body = '';
        const maxBytes = 30000;
        let bytesRead = 0;

        res.on('data', (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead <= maxBytes) body += chunk.toString();
        });

        res.on('end', () => {
          let contentSnippet = '';
          try {
            let cleaned = body
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '');
            const paragraphs = [];
            const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
            let pMatch;
            while ((pMatch = pRegex.exec(cleaned)) !== null) {
              const text = pMatch[1].replace(/<[^>]+>/g, '').trim();
              if (text.length > 40) paragraphs.push(text);
            }
            contentSnippet = paragraphs.slice(0, 3).join(' ').substring(0, 400);
          } catch { /* content extraction failed */ }

          resolve({
            url: candidate.url,
            title: candidate.title || '',
            source: candidate.source || '',
            claim: candidate.claim || '',
            contentSnippet: contentSnippet || candidate.contentSnippet || '',
            authorityScore: candidate.authorityScore || scoreAuthority(candidate.url),
          });
        });

        res.on('error', () => resolve({
          url: candidate.url,
          title: candidate.title || '',
          source: candidate.source || '',
          claim: candidate.claim || '',
          contentSnippet: candidate.contentSnippet || '',
          authorityScore: candidate.authorityScore || 1,
        }));
      } else {
        res.resume();
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Format verified web sources into a block for the article writing prompt.
 * Groups by authority level for the writer's reference.
 */
export function formatWebSourcesForPrompt(sources) {
  if (!sources || sources.length === 0) {
    return '\nVERIFIED SOURCES:\nNo verified external sources found. Reference studies/publications by name only — do NOT create any external hyperlinks. Do NOT fabricate URLs.\n';
  }

  let block = '\nVERIFIED SOURCES (use ONLY these URLs for external links — do NOT invent any other URLs):\n';

  const highAuthority = sources.filter(s => s.authorityScore >= 7);
  const medAuthority = sources.filter(s => s.authorityScore >= 3 && s.authorityScore < 7);
  const otherSources = sources.filter(s => s.authorityScore < 3);

  if (highAuthority.length > 0) {
    block += '\nACADEMIC & INSTITUTIONAL SOURCES:\n';
    for (const s of highAuthority) {
      block += `- "${s.title}" (${s.source}) — ${s.url}`;
      if (s.contentSnippet) block += `\n  Preview: ${s.contentSnippet.substring(0, 200)}`;
      if (s.claim && s.claim !== 'general') block += `\n  Supports: ${s.claim}`;
      block += '\n';
    }
  }

  if (medAuthority.length > 0) {
    block += '\nAUTHORITATIVE MEDIA SOURCES:\n';
    for (const s of medAuthority) {
      block += `- "${s.title}" (${s.source}) — ${s.url}`;
      if (s.contentSnippet) block += `\n  Preview: ${s.contentSnippet.substring(0, 200)}`;
      if (s.claim && s.claim !== 'general') block += `\n  Supports: ${s.claim}`;
      block += '\n';
    }
  }

  if (otherSources.length > 0) {
    block += '\nADDITIONAL SOURCES:\n';
    for (const s of otherSources) {
      block += `- "${s.title}" (${s.source}) — ${s.url}`;
      if (s.contentSnippet) block += `\n  Preview: ${s.contentSnippet.substring(0, 200)}`;
      block += '\n';
    }
  }

  block += '\nRULES:\n';
  block += '- ONLY use URLs from the list above for hyperlinks\n';
  block += '- Prefer academic/institutional sources when making scientific claims\n';
  block += '- If a claim cannot be supported by these sources, mention the finding by name WITHOUT a hyperlink\n';
  block += '- NEVER fabricate, guess, or invent URLs\n';
  block += '- Aim for 3-6 properly hyperlinked source references throughout the article\n';
  block += '- Use descriptive anchor text (not "click here" or bare URLs)\n';

  return block;
}
