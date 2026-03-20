// Article Rewriter — Layer 2: Surgically fix bio validation issues
// When bioValidator finds contradictions, this sends the article back to Opus
// for targeted fixes. Max 2 rewrite attempts before blocking (Layer 3).

import Anthropic from '@anthropic-ai/sdk';
import { getAllPersonalDetails } from '../data/personalDetailsRegistry.js';

const anthropic = new Anthropic();

/**
 * Surgically rewrite sections of an article that contradict the author's biography.
 * Uses Claude Opus for high-quality, targeted edits.
 * Supports both flat and domain-keyed detail banks.
 *
 * @param {string} domainOrAuthor - Site domain (if 5 args) or author name (if 4 args)
 * @param {string} authorOrHtml - Author name (if 5 args) or article HTML (if 4 args)
 * @param {string} htmlOrTitle - Article HTML (if 5 args) or article title (if 4 args)
 * @param {string|string[]} titleOrIssues - Article title (if 5 args) or issues array (if 4 args)
 * @param {string[]} [maybeIssues] - Issues array (only if 5 args)
 * @returns {Promise<{ html: string, fixed: boolean, fixSummary: string }>}
 */
export async function rewriteForBioConsistency(domainOrAuthor, authorOrHtml, htmlOrTitle, titleOrIssues, maybeIssues) {
  // Support both (domain, author, html, title, issues) and (author, html, title, issues) signatures
  let authorName, articleHtml, articleTitle, issues;
  if (maybeIssues !== undefined) {
    // 5-arg: (domain, authorName, html, title, issues)
    const domain = domainOrAuthor;
    authorName = authorOrHtml;
    articleHtml = htmlOrTitle;
    articleTitle = titleOrIssues;
    issues = maybeIssues;
    const allDetails = getAllPersonalDetails();
    var detailBank = allDetails[domain]?.[authorName] || allDetails[authorName] || null;
  } else {
    // 4-arg: (authorName, html, title, issues)
    authorName = domainOrAuthor;
    articleHtml = authorOrHtml;
    articleTitle = htmlOrTitle;
    issues = titleOrIssues;
    var detailBank = getAllPersonalDetails()[authorName] || null;
  }

  if (!detailBank || typeof detailBank !== 'string') {
    return { html: articleHtml, fixed: false, fixSummary: 'No detail bank available' };
  }

  try {
    const plainText = articleHtml.replace(/<[^>]*>/g, '').trim();
    // Use more of the article for rewriting context than validation
    const textForContext = plainText.substring(0, 12000);

    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: `You are a surgical article editor. Your job is to fix SPECIFIC biographical contradictions in an article while preserving the article's voice, structure, flow, and quality.

RULES:
1. ONLY fix the specific issues listed. Do NOT rewrite sections that are fine.
2. Preserve the author's voice and writing style exactly.
3. Preserve all HTML formatting, links, image placeholders, and structure.
4. When fixing a contradiction, find the MINIMAL change that resolves it. For example:
   - If the article says the author is "widowed" but they're married, change the scene to reflect their actual relationship status
   - If the article invents a family member's death, remove or rewrite that passage to use a real detail from the author's life
   - If the article fabricates a major life event, replace it with something consistent with the author's actual biography
5. The fix should read naturally — it should not feel like a patch or correction.
6. Return the COMPLETE article HTML with fixes applied.

Respond with ONLY a JSON object:
{
  "html": "<p>Complete fixed article HTML...</p>",
  "changes": ["Brief description of each change made"]
}`,
      messages: [{
        role: 'user',
        content: `ARTICLE TITLE: "${articleTitle}"
AUTHOR: ${authorName}

AUTHOR'S PERSONAL DETAIL BANK:
${detailBank}

ISSUES TO FIX:
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

ARTICLE HTML TO FIX:
${articleHtml}

Fix ONLY the listed issues. Return the complete fixed article as JSON.`,
      }],
    });

    const text = resp.content[0]?.text?.trim();
    if (!text) {
      return { html: articleHtml, fixed: false, fixSummary: 'Empty response from rewriter' };
    }

    try {
      // Parse JSON response
      let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        cleaned = cleaned.substring(start, end + 1);
      }

      // Try standard parse first
      let result;
      try {
        result = JSON.parse(cleaned);
      } catch {
        // Manual extraction fallback for large HTML that breaks JSON
        const htmlMatch = cleaned.match(/"html"\s*:\s*"([\s\S]*?)"\s*,\s*"changes"/);
        if (htmlMatch) {
          const changesMatch = cleaned.match(/"changes"\s*:\s*\[([\s\S]*?)\]/);
          result = {
            html: htmlMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
            changes: changesMatch ? JSON.parse(`[${changesMatch[1]}]`) : ['Changes applied'],
          };
        }
      }

      if (result?.html) {
        const fixSummary = (result.changes || []).join('; ');
        console.log(`[ArticleRewriter] Fixed ${(result.changes || []).length} issue(s) for "${authorName}": ${fixSummary}`);
        return { html: result.html, fixed: true, fixSummary };
      }
    } catch (parseErr) {
      console.warn(`[ArticleRewriter] Failed to parse rewrite response: ${parseErr.message}`);
    }

    return { html: articleHtml, fixed: false, fixSummary: 'Failed to parse rewrite response' };
  } catch (err) {
    console.warn(`[ArticleRewriter] Rewrite failed: ${err.message}`);
    return { html: articleHtml, fixed: false, fixSummary: `Rewrite error: ${err.message}` };
  }
}

export default rewriteForBioConsistency;
