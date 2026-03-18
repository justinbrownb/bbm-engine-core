// Title Claim Verification Gate
// Extracts specific factual claims from titles, searches Google News RSS
// to verify they exist in real news, and recommends draft vs publish.
//
// NEWS titles (hard factual claims): unverifiable claim → save as draft
// LIFESTYLE/PSYCHOLOGY titles (observational): unverifiable → soft warning passed to writer

import Anthropic from '@anthropic-ai/sdk';
import https from 'https';

const anthropic = new Anthropic();

const USER_AGENT = 'Mozilla/5.0 (compatible; TitleVerifier/1.0)';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Verify factual claims in a title before writing the article.
 *
 * @param {string} title - The article title to verify
 * @param {string} style - 'news' or 'lifestyle' (determines strictness)
 * @returns {object} { verified, claims, unverifiedClaims, recommendation, warnings }
 *   - verified: boolean — true if all claims check out (or title is purely observational)
 *   - claims: array of { claim, searchQuery, resultsFound, verified }
 *   - unverifiedClaims: array of claim strings that couldn't be verified
 *   - recommendation: 'publish' | 'draft' | 'warn'
 *   - warnings: array of strings to pass to the writer as caveats
 */
export async function verifyTitleClaims(title, style = 'lifestyle') {
  const result = {
    verified: true,
    claims: [],
    unverifiedClaims: [],
    recommendation: 'publish',
    warnings: [],
  };

  try {
    // Step 1: Extract factual claims from the title using Haiku
    const extractedClaims = await extractClaims(title);

    if (!extractedClaims || extractedClaims.length === 0) {
      // Purely observational title — no specific claims to verify
      console.log(`[TitleVerify] "${title.substring(0, 60)}..." — no specific claims to verify (observational title)`);
      return result;
    }

    console.log(`[TitleVerify] "${title.substring(0, 60)}..." — ${extractedClaims.length} claim(s) to verify`);

    // Step 2: Search Google News RSS for each claim
    for (const claim of extractedClaims) {
      const searchResults = await searchGoogleNews(claim.searchQuery);
      const verified = searchResults.length > 0;

      result.claims.push({
        claim: claim.claim,
        searchQuery: claim.searchQuery,
        resultsFound: searchResults.length,
        verified,
      });

      if (!verified) {
        result.unverifiedClaims.push(claim.claim);
        result.verified = false;
      }

      // Rate limiting between searches
      await new Promise(r => setTimeout(r, 500));
    }

    // Step 3: Determine recommendation based on style and verification results
    if (result.unverifiedClaims.length > 0) {
      if (style === 'news') {
        // NEWS titles: strict — unverifiable specific claims → draft
        result.recommendation = 'draft';
        result.warnings = result.unverifiedClaims.map(c =>
          `UNVERIFIABLE CLAIM (news title): "${c}" — could not find this in any recent news source. Article saved as draft for manual review.`
        );
        console.log(`[TitleVerify] NEWS title FAILED — ${result.unverifiedClaims.length} unverifiable claim(s). Recommending DRAFT.`);
      } else {
        // LIFESTYLE/PSYCHOLOGY titles: soft — note for the writer but still publish
        result.recommendation = 'warn';
        result.warnings = result.unverifiedClaims.map(c =>
          `The following title claim could not be independently verified: "${c}". Write the article without relying on this specific claim as established fact. Frame it as observation or interpretation rather than a verified finding.`
        );
        console.log(`[TitleVerify] Lifestyle title has ${result.unverifiedClaims.length} unverifiable claim(s). Recommending WARN (soft caveat to writer).`);
      }
    } else {
      console.log(`[TitleVerify] All ${result.claims.length} claim(s) verified. Recommending PUBLISH.`);
    }

    return result;
  } catch (e) {
    console.warn(`[TitleVerify] Verification failed (non-blocking): ${e.message}`);
    // On error, don't block — just publish with a note
    result.warnings.push('Title claim verification encountered an error and was skipped.');
    return result;
  }
}

/**
 * Use Claude Haiku to extract specific factual claims from a title.
 * Returns only claims that are verifiable — not opinions or observations.
 */
async function extractClaims(title) {
  const prompt = `Analyze this article title and extract any SPECIFIC FACTUAL CLAIMS that could be verified through news searches.

Title: "${title}"

Extract claims that involve:
- Named institutions, companies, or organizations doing something specific
- Court rulings, government actions, or policy changes
- Specific statistics, percentages, or dollar figures
- Named researchers or specific study findings
- Specific events with verifiable details (dates, locations, outcomes)
- Authority claims: title says "psychologists explain", "researchers found", "studies show", "neuroscientists reveal", "therapists say", "experts warn", "scientists discover", "a new study", or similar phrases that attribute the claim to professionals or research — these MUST be extracted as claims because the article needs to actually cite those professionals/studies

Do NOT extract:
- Well-known psychological concepts referenced by name only
- Rhetorical framing or editorial interpretation
- Commonly accepted facts that don't need news verification
- Simple observations WITHOUT authority attribution ("people who X tend to Y" is fine, but "psychologists say people who X tend to Y" IS a claim)

For each claim, provide a concise search query that would find news articles about it.

Return a JSON array. If the title is purely observational with no specific verifiable claims, return an empty array [].

Format:
[
  { "claim": "the specific factual claim", "searchQuery": "concise Google News search query" }
]

Return ONLY the JSON array, no other text.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content[0]?.text || '[]';
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const claims = JSON.parse(jsonMatch[0]);
    return Array.isArray(claims) ? claims : [];
  } catch (e) {
    console.warn(`[TitleVerify] Claim extraction failed: ${e.message}`);
    return [];
  }
}

/**
 * Search Google News RSS for articles matching a query.
 * Returns an array of { title, url, source } objects.
 */
async function searchGoogleNews(query) {
  if (!query || query.trim().length === 0) return [];

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

  try {
    // Simple RSS parsing — extract <item> blocks
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const itemXml = match[1];
      const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
      const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      if (titleMatch) {
        items.push({
          title: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          url: linkMatch ? linkMatch[1].trim() : '',
          source: sourceMatch ? sourceMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '',
        });
      }
    }
    return items;
  } catch (e) {
    console.warn(`[TitleVerify] RSS parse failed: ${e.message}`);
    return [];
  }
}
