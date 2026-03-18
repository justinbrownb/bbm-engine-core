/**
 * Citation Validator — Post-write check that articles actually use verified sources
 *
 * After an article is written, this module:
 * 1. Extracts all hyperlinks from the HTML content
 * 2. Compares them against the verified sources that were provided to the writer
 * 3. Checks that statistics/claims have inline hyperlinks
 * 4. Returns a validation result with pass/fail and specific issues
 *
 * This is the final quality gate before publishing.
 */

import Anthropic from '@anthropic-ai/sdk';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Extract all hyperlinks from HTML content.
 * Returns array of { url, anchorText }
 */
function extractLinks(htmlContent) {
  const links = [];
  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(htmlContent)) !== null) {
    const url = match[1].trim();
    const anchorText = match[2].replace(/<[^>]+>/g, '').trim();

    // Skip internal links, image credits, and anchors
    if (url.startsWith('#') || url.startsWith('mailto:')) continue;

    links.push({ url, anchorText });
  }

  return links;
}

/**
 * Validate that an article properly cites its sources.
 *
 * @param {string} htmlContent - The article HTML
 * @param {Array<{url: string, title: string}>} verifiedSources - Sources that were provided to the writer
 * @param {string} siteDomain - Own domain to distinguish internal vs external links
 * @returns {Promise<{passed: boolean, score: number, issues: string[], externalLinkCount: number, sourceUsageRate: number}>}
 */
export async function validateCitations(htmlContent, verifiedSources = [], siteDomain = '', tier = null) {
  const allLinks = extractLinks(htmlContent);

  // Separate internal vs external links
  const externalLinks = allLinks.filter(l => !l.url.includes(siteDomain) && l.url.startsWith('http'));
  const internalLinks = allLinks.filter(l => l.url.includes(siteDomain));

  const issues = [];
  let score = 100; // Start at 100, deduct for issues

  // Tier-aware thresholds for SC content engine
  // News/WorldEvents: min 3, target 5 | Psychology/Adjacent: min 5, target 8 | DeepDive/WeeklyExclusive: min 8, target 15
  let minLinks = 3;
  let targetLinks = 6;
  if (tier === 'deepdive' || tier === 'weeklyExclusive') {
    minLinks = 8;
    targetLinks = 15;
  } else if (tier === 'psychology' || tier === 'adjacent') {
    minLinks = 5;
    targetLinks = 8;
  } else if (tier === 'news' || tier === 'worldEvents') {
    minLinks = 3;
    targetLinks = 5;
  }

  // CHECK 1: Minimum external source links (tier-aware)
  if (externalLinks.length === 0) {
    issues.push(`CRITICAL: Article has ZERO external source links — ${tier || 'article'} requires at least ${minLinks}`);
    score -= 60;
  } else if (externalLinks.length < minLinks) {
    issues.push(`CRITICAL: Article has only ${externalLinks.length} external source link(s) — ${tier || 'article'} minimum is ${minLinks}`);
    score -= 30;
  } else if (externalLinks.length < targetLinks) {
    issues.push(`WARNING: Article has only ${externalLinks.length} external source links — ${tier || 'article'} target is ${targetLinks}`);
    score -= 15;
  }

  // CHECK 2: How many of the verified sources were actually used?
  if (verifiedSources.length > 0) {
    const usedSources = verifiedSources.filter(vs =>
      externalLinks.some(el => {
        // Match by domain or partial URL
        try {
          const vsHost = new URL(vs.url).hostname;
          const elHost = new URL(el.url).hostname;
          return vsHost === elHost || el.url.includes(vs.url) || vs.url.includes(el.url);
        } catch {
          return el.url.includes(vs.url) || vs.url.includes(el.url);
        }
      })
    );

    const sourceUsageRate = usedSources.length / verifiedSources.length;

    if (sourceUsageRate === 0) {
      issues.push('CRITICAL: Article uses NONE of the verified sources provided — all external links may be fabricated');
      score -= 50;
    } else if (sourceUsageRate < 0.25) {
      issues.push(`WARNING: Article uses only ${usedSources.length}/${verifiedSources.length} verified sources (${Math.round(sourceUsageRate * 100)}%)`);
      score -= 20;
    }
  }

  // CHECK 3: Check for likely fabricated URLs (not in verified sources list)
  if (verifiedSources.length > 0) {
    const unverifiedExternalLinks = externalLinks.filter(el => {
      // Skip image credits (pexels, flickr, unsplash, pixabay)
      const creditDomains = ['pexels.com', 'flickr.com', 'unsplash.com', 'pixabay.com'];
      if (creditDomains.some(d => el.url.includes(d))) return false;

      return !verifiedSources.some(vs => {
        try {
          const vsHost = new URL(vs.url).hostname;
          const elHost = new URL(el.url).hostname;
          return vsHost === elHost;
        } catch {
          return el.url.includes(vs.url) || vs.url.includes(el.url);
        }
      });
    });

    if (unverifiedExternalLinks.length > 0) {
      issues.push(`WARNING: ${unverifiedExternalLinks.length} external link(s) not from verified sources: ${unverifiedExternalLinks.map(l => l.url.substring(0, 60)).join(', ')}`);
      score -= unverifiedExternalLinks.length * 10;
    }
  }

  // CHECK 4: Use Haiku to check if statistics lack hyperlinks
  const statsCheck = await checkStatisticsHaveLinks(htmlContent);
  if (statsCheck.unlinkedStats.length > 0) {
    for (const stat of statsCheck.unlinkedStats.slice(0, 5)) {
      issues.push(`MISSING LINK: Statistic "${stat}" has no hyperlink to a source`);
    }
    score -= statsCheck.unlinkedStats.length * 8;
  }

  // CHECK 5: Internal links (should have at least 2)
  if (internalLinks.length === 0) {
    issues.push('WARNING: Article has no internal links to other site articles');
    score -= 5;
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));
  const passed = score >= 50;

  return {
    passed,
    score,
    issues,
    externalLinkCount: externalLinks.length,
    internalLinkCount: internalLinks.length,
    sourceUsageRate: verifiedSources.length > 0
      ? externalLinks.filter(el => verifiedSources.some(vs => {
          try { return new URL(el.url).hostname === new URL(vs.url).hostname; } catch { return false; }
        })).length / verifiedSources.length
      : null,
  };
}

/**
 * Use Claude Haiku to identify statistics/data points in the article that lack hyperlinks.
 * Returns { unlinkedStats: string[] }
 */
async function checkStatisticsHaveLinks(htmlContent) {
  try {
    const anthropic = getClient();
    const contentPreview = htmlContent.substring(0, 12000);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Review this article HTML and find any SPECIFIC statistics, percentages, study findings, or data points that do NOT have a hyperlink (<a> tag) nearby. Only flag claims that include specific numbers, percentages, dates of studies, or named research findings.

Do NOT flag:
- General statements without specific numbers
- Well-known common knowledge facts
- Image credits or attribution links
- Internal editorial references

Article HTML (first 12000 chars):
${contentPreview}

Return ONLY a JSON object (no markdown):
{"unlinkedStats": ["stat 1 text", "stat 2 text", ...]}

If all statistics are properly linked, return {"unlinkedStats": []}.`
      }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { unlinkedStats: Array.isArray(result.unlinkedStats) ? result.unlinkedStats : [] };
    }
    return { unlinkedStats: [] };
  } catch (e) {
    console.warn(`[CitationValidator] Stats check failed: ${e.message}`);
    return { unlinkedStats: [] };
  }
}

export default { validateCitations };
