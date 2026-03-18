/**
 * FACT-CHECK UTILITY — Post-write verification step
 *
 * After an article is written, this module:
 * 1. Extracts specific factual claims (studies, statistics, named events, numbers)
 * 2. Cross-references claims against the verified sources that were used
 * 3. Searches for verification of claims not covered by existing sources
 * 4. Corrects or softens any unverifiable/fabricated claims
 * 5. Ensures all referenced studies/sources have working hyperlinks
 *
 * Uses Claude Sonnet for reasoning quality. Adds ~10-15 seconds per article.
 */

import Anthropic from '@anthropic-ai/sdk';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;

let anthropicClient = null;

function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Fact-check and fix an article's content.
 *
 * @param {string} htmlContent - The article HTML content from the writer
 * @param {string} title - The article title
 * @param {Array} verifiedSources - Sources from sourceResearch.js (may be empty)
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.extraRules] - Additional domain-specific fact-check rules to inject into the prompt
 * @returns {Promise<{content: string, corrections: Array, sourcesAdded: number}>}
 */
export async function factCheckArticle(htmlContent, title, verifiedSources = [], { extraRules = '' } = {}) {
  try {
    console.log(`[FactCheck] Starting fact-check for: "${title.substring(0, 60)}..."`);

    // STEP 1: Extract claims and assess them with Sonnet
    const assessment = await assessClaims(htmlContent, title, verifiedSources, extraRules);

    if (!assessment || assessment.length === 0) {
      console.log(`[FactCheck] No claims flagged — article passes`);
      return { content: htmlContent, corrections: [], sourcesAdded: 0 };
    }

    // STEP 2: For claims that need verification, search for real sources
    const claimsNeedingSearch = assessment.filter(c => c.action === 'search_and_verify' || c.action === 'needs_source_url');
    let newSources = [];
    if (claimsNeedingSearch.length > 0) {
      newSources = await searchForClaimSources(claimsNeedingSearch);
      console.log(`[FactCheck] Found ${newSources.length} additional verified sources`);
    }

    // STEP 3: Apply corrections — fix content with Sonnet
    const allSources = [...verifiedSources, ...newSources];
    const fixed = await applyCorrections(htmlContent, title, assessment, allSources);

    const corrections = assessment.filter(c => c.action !== 'pass');
    console.log(`[FactCheck] Complete: ${corrections.length} corrections applied, ${newSources.length} sources added`);

    return {
      content: fixed || htmlContent,
      corrections,
      sourcesAdded: newSources.length,
    };
  } catch (e) {
    console.warn(`[FactCheck] Fact-check failed (publishing original): ${e.message}`);
    return { content: htmlContent, corrections: [], sourcesAdded: 0 };
  }
}

/**
 * STEP 1: Use Sonnet to extract and assess every factual claim.
 * Returns array of { claim, verdict, action, searchQuery?, reason }
 */
async function assessClaims(htmlContent, title, verifiedSources, extraRules = '') {
  const client = getClient();

  // Strip HTML for cleaner analysis
  const plainText = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const sourcesContext = verifiedSources.length > 0
    ? `\nVERIFIED SOURCES USED DURING WRITING:\n${verifiedSources.map(s => `- "${s.title}" (${s.source}) — ${s.url}`).join('\n')}`
    : '\nNo verified sources were available during writing.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `You are a fact-checker for a digital news publication. Your job is to review this article and identify every specific factual claim that could be verified or debunked.

ARTICLE TITLE: "${title}"

ARTICLE TEXT:
${plainText.substring(0, 8000)}
${sourcesContext}

For EACH specific factual claim in the article, assess it:

TYPES OF CLAIMS TO CHECK:
- Named studies or research papers (journal, year, authors, institution)
- Specific statistics or numbers (percentages, dollar amounts, population figures)
- Named events (dates, locations, outcomes)
- Attributed quotes or findings ("researchers at X found...")
- Institutional reports (WHO, World Gold Council, BIS, etc.)
- Named people and their credentials/roles
- Named academic concepts, theories, or frameworks referenced WITHOUT a hyperlink (e.g., "moral licensing", "attachment theory", "cognitive dissonance", "the Dunning-Kruger effect")
- Vague research references like "research has shown", "studies suggest", "research has explored" that don't cite or link to any specific source

For each claim, provide a verdict:
- "verified" — The claim matches a verified source provided, or is well-established common knowledge AND already has a hyperlink in the article
- "plausible_but_unverified" — The general direction is correct but specific numbers/studies can't be confirmed from provided sources
- "likely_fabricated" — The specific study, statistic, or source appears to be invented (specific journal + year + finding combinations that don't match known research)
- "needs_source_url" — The claim references a real concept, theory, or research finding but the article doesn't hyperlink to any authoritative source for it
- "exaggerated" — The real data exists but the article overstates or misrepresents it

And an action:
- "pass" — No changes needed
- "soften" — Change definitive language to hedged language ("research suggests" instead of "a 2024 study found")
- "remove" — Remove the fabricated claim entirely
- "correct" — Fix the specific number/detail
- "search_and_verify" — Search for the real source to verify or replace the claim
- "needs_source_url" — Search for a URL to link to this claim

CRITICAL DETECTION RULES:
- A study with a SPECIFIC journal name + SPECIFIC year + SPECIFIC finding is suspect if it wasn't in the verified sources. LLMs commonly fabricate these.
- Precise percentages (e.g., "12.4% lower", "21.6% improvement") attributed to specific studies are HIGH suspicion for fabrication unless sourced.
- Named researchers at named institutions studying specific topics — verify if plausible.
- Round numbers ("over 290 tonnes") that differ from known data points should be flagged.
- Simple factual definitions ("cortisol is a stress hormone") don't need checking if they are basic biology/science.
- HOWEVER: Named psychological/scientific CONCEPTS, THEORIES, or FRAMEWORKS (e.g., "moral licensing", "self-determination theory", "the paradox of choice") MUST have a hyperlink to an authoritative source (Wikipedia, APA, university page, published paper). If the article mentions the concept by name but doesn't link to anything, flag it as "needs_source_url".
- Phrases like "research has shown", "studies suggest", "research has explored", "according to psychologists" WITHOUT any hyperlink or specific citation should be flagged as "needs_source_url" — the article should either cite the specific research or link to an authoritative overview.
- An article with ZERO hyperlinked sources is a strong red flag — nearly every factual claim or concept reference should be checked.
${extraRules ? `\n${extraRules}` : ''}
Return ONLY a JSON array (no backticks, no markdown):
[
  {
    "claim": "the specific claim text",
    "verdict": "verified|plausible_but_unverified|likely_fabricated|needs_source_url|exaggerated",
    "action": "pass|soften|remove|correct|search_and_verify|needs_source_url",
    "searchQuery": "targeted search query to find the real source (only if action involves searching)",
    "reason": "brief explanation",
    "correction": "what the text should say instead (only for soften/correct actions)"
  }
]

Include both SPECIFIC factual claims AND unsourced concept/theory references. Simple common-knowledge definitions without named concepts can be skipped. If the article is clean and well-sourced, return an empty array [].`
    }],
  });

  const text = response.content[0]?.text || '';
  const cleaned = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');

  try {
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const claims = JSON.parse(jsonMatch[0]);
      // Filter out "pass" verdicts — we only care about problems
      return claims.filter(c => c.action !== 'pass');
    }
    return [];
  } catch (e) {
    console.warn(`[FactCheck] Failed to parse claim assessment: ${e.message}`);
    return [];
  }
}

/**
 * STEP 2: Search for real sources for flagged claims.
 * Uses Google News RSS (same as sourceResearch.js) to find real URLs.
 */
async function searchForClaimSources(claims) {
  const allSources = [];

  const searchPromises = claims
    .filter(c => c.searchQuery)
    .slice(0, 5) // Max 5 searches to keep it fast
    .map(async (claim) => {
      try {
        const results = await searchAndResolve(claim.searchQuery);
        for (const r of results.slice(0, 2)) {
          allSources.push({
            url: r.url,
            title: r.title,
            source: r.source,
            claim: claim.claim,
          });
        }
      } catch (e) {
        console.warn(`[FactCheck] Search failed for "${claim.searchQuery}": ${e.message}`);
      }
    });

  await Promise.allSettled(searchPromises);

  // Deduplicate
  const seen = new Set();
  return allSources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

/**
 * Search Google News RSS and resolve redirect URLs.
 */
async function searchAndResolve(query) {
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
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });

  if (!xml) return [];

  // Parse items
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
    if (linkMatch) {
      items.push({
        title: (titleMatch?.[1] || titleMatch?.[2] || '').trim(),
        url: linkMatch[1].trim(),
        source: (sourceMatch?.[1] || '').trim(),
      });
    }
  }

  // Resolve Google News redirect URLs
  const resolved = await Promise.allSettled(
    items.slice(0, 5).map(async (item) => {
      if (!item.url.includes('news.google.com')) return item;

      const realUrl = await followRedirect(item.url);
      if (realUrl) return { ...item, url: realUrl };
      return null;
    })
  );

  return resolved
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
    .filter(r => !r.url.includes('news.google.com'));
}

/**
 * Follow HTTP redirects to resolve a URL.
 */
function followRedirect(startUrl, maxRedirects = 5) {
  return new Promise((resolve) => {
    let redirectCount = 0;

    function follow(url) {
      if (redirectCount >= maxRedirects) { resolve(null); return; }

      let parsedUrl;
      try { parsedUrl = new URL(url); } catch { resolve(null); return; }

      const client = parsedUrl.protocol === 'https:' ? https : http;
      const req = client.request(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          let redirectUrl;
          try { redirectUrl = new URL(res.headers.location, url).toString(); } catch { resolve(null); return; }
          if (!redirectUrl.includes('news.google.com') && !redirectUrl.includes('google.com/rss')) {
            resolve(redirectUrl);
          } else {
            follow(redirectUrl);
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(!url.includes('news.google.com') ? url : null);
        } else {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    }

    follow(startUrl);
  });
}

/**
 * Verify a single URL is reachable. Returns the final URL or null.
 */
function verifyUrl(urlStr) {
  return new Promise((resolve) => {
    let parsedUrl;
    try { parsedUrl = new URL(urlStr); } catch { resolve(null); return; }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 400) {
        resolve(urlStr);
      } else {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * STEP 3: Apply corrections to the article HTML using Sonnet.
 * This rewrites problematic sections while preserving the rest.
 */
async function applyCorrections(htmlContent, title, flaggedClaims, allSources) {
  if (flaggedClaims.length === 0) return htmlContent;

  const client = getClient();

  const claimsBlock = flaggedClaims.map((c, i) => {
    let entry = `${i + 1}. CLAIM: "${c.claim}"
   VERDICT: ${c.verdict}
   ACTION: ${c.action}
   REASON: ${c.reason}`;
    if (c.correction) {
      entry += `\n   SUGGESTED FIX: ${c.correction}`;
    }
    return entry;
  }).join('\n\n');

  const sourcesBlock = allSources.length > 0
    ? `\nAVAILABLE VERIFIED SOURCES (use these URLs to add hyperlinks where claims reference studies/reports):\n${allSources.map(s => `- "${s.title}" (${s.source}) — ${s.url}${s.claim ? ` [relevant to: ${s.claim}]` : ''}`).join('\n')}`
    : '\nNo additional sources available.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `You are a fact-checking editor. Your job is to fix specific problems in this article while preserving everything else exactly as-is.

ARTICLE TITLE: "${title}"

ORIGINAL HTML CONTENT:
${htmlContent}

FLAGGED CLAIMS REQUIRING FIXES:
${claimsBlock}
${sourcesBlock}

EDITING RULES:
1. For "soften" actions: Change definitive attribution to hedged language. E.g.:
   - "A 2024 study in the Journal of X found that..." → "Research suggests that..."
   - "Researchers at Stanford discovered..." → "Studies have indicated..."
   - Keep the SUBSTANCE of the claim if it's directionally correct, just remove the fake specifics.

2. For "remove" actions: Delete the sentence or paragraph containing the fabricated claim. Smooth the transition so the removal isn't jarring.

3. For "correct" actions: Fix the specific number or detail using the suggested correction.

4. For "needs_source_url" / "search_and_verify" actions: If a matching verified source URL is available in the AVAILABLE VERIFIED SOURCES list above, ADD a hyperlink (<a href="URL" target="_blank">descriptive anchor text</a>) to the relevant text. If no source URL is available for this claim, SOFTEN the language instead — do NOT invent or guess a URL.
   CRITICAL: You may ONLY use URLs that appear in the AVAILABLE VERIFIED SOURCES list above. NEVER generate, guess, or fabricate any URL — not even to well-known sites like Wikipedia, APA, SAGE, PubMed, etc. If a URL is not explicitly provided in the sources list, do not link to it.

5. PRESERVE everything that wasn't flagged — don't rewrite sentences that are fine.

6. Maintain the same HTML structure (p tags, h2 tags, a tags, em tags, image placeholders).

7. Do NOT add any new claims or embellish. Only fix what was flagged.

8. When adding source hyperlinks, use descriptive anchor text (e.g., "research published in Nature" or "according to the World Gold Council") — NOT "click here" or bare URLs.

Return ONLY the corrected HTML content. No JSON wrapper, no backticks, no explanation — just the HTML.`
    }],
  });

  const corrected = response.content[0]?.text || '';

  // Clean up any accidental markdown wrappers
  let cleaned = corrected.trim();
  if (cleaned.startsWith('```html')) {
    cleaned = cleaned.replace(/^```html\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  // Sanity check — make sure we got actual HTML back
  if (cleaned.length < htmlContent.length * 0.3) {
    console.warn(`[FactCheck] Corrected content suspiciously short (${cleaned.length} vs ${htmlContent.length}), using original`);
    return htmlContent;
  }

  // URL validation — reject if Sonnet hallucinated URLs not in our source list
  const urlRegex = /href="(https?:\/\/[^"]+)"/gi;
  const originalUrls = new Set((htmlContent.match(urlRegex) || []).map(m => m.match(/href="([^"]+)"/)[1]));
  const fixedUrls = new Set((cleaned.match(urlRegex) || []).map(m => m.match(/href="([^"]+)"/)[1]));

  // Build allowed URL set from original content + all verified sources
  const allowedUrls = new Set(originalUrls);
  for (const s of allSources) {
    if (s.url) allowedUrls.add(s.url);
  }

  const hallucinated = [...fixedUrls].filter(u => !allowedUrls.has(u));
  if (hallucinated.length > 0) {
    console.warn(`[FactCheck] Corrected content has ${hallucinated.length} hallucinated URL(s), using original:`);
    hallucinated.forEach(u => console.warn(`  - ${u}`));
    return htmlContent;
  }

  return cleaned;
}
