// Detail Selector — Cherry-picks 3-5 personal details relevant to an article title
// Uses Claude Haiku for fast, cheap selection from the full detail bank

import Anthropic from '@anthropic-ai/sdk';
import { personalDetailBanks } from '../data/personalDetails.js';

const anthropic = new Anthropic();

/**
 * Select 3-5 personal details from an author's detail bank that are most relevant to the article title.
 * @param {string} authorName - Full name of the author (must match key in personalDetailBanks)
 * @param {string} articleTitle - The title of the article being written
 * @param {string} topicContext - Optional additional context (tier, trend info, etc.)
 * @returns {string|null} - Selected details as formatted string, or null if no bank found
 */
export async function selectRelevantDetails(authorName, articleTitle, topicContext = '') {
  const detailBank = personalDetailBanks[authorName];
  if (!detailBank) {
    console.log(`[DetailSelector] No detail bank found for "${authorName}" — skipping`);
    return null;
  }

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `You are a detail selector. Given an article title and an author's personal detail bank, select 3-5 details that would be most naturally relevant to the article topic. Return ONLY the selected details, one per line, exactly as they appear in the bank. Do not add commentary, numbering, or modifications.`,
      messages: [{
        role: 'user',
        content: `ARTICLE TITLE: "${articleTitle}"
${topicContext ? `CONTEXT: ${topicContext}\n` : ''}
AUTHOR: ${authorName}

PERSONAL DETAIL BANK:
${detailBank}

Select 3-5 details from above that are most relevant to this article's topic. Return them exactly as written, one per line.`
      }],
    });

    const selected = resp.content[0]?.text?.trim();
    if (!selected) return null;

    console.log(`[DetailSelector] Selected ${selected.split('\n').length} details for "${authorName}" on "${articleTitle.substring(0, 50)}..."`);
    return selected;
  } catch (err) {
    console.warn(`[DetailSelector] Haiku selection failed (non-fatal): ${err.message}`);
    return null;
  }
}

export default selectRelevantDetails;
