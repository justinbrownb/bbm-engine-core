// Biography Validator — Post-writing check for biography consistency
// Uses Claude Haiku to validate article against author's full detail bank

import Anthropic from '@anthropic-ai/sdk';
import { getAllPersonalDetails } from '../data/personalDetailsRegistry.js';

const anthropic = new Anthropic();

/**
 * Validate a written article against the author's personal detail bank.
 * Checks for contradictions, fabricated biographical details, and tone inconsistencies.
 * @param {string} authorName - Full name of the author
 * @param {string} articleHtml - The written article HTML
 * @param {string} articleTitle - The article title
 * @returns {object} - { valid: boolean, issues: string[] }
 */
export async function validateBiography(authorName, articleHtml, articleTitle) {
  const detailBank = getAllPersonalDetails()[authorName];
  if (!detailBank) {
    // No detail bank = can't validate, pass through
    return { valid: true, issues: [] };
  }

  try {
    // Strip HTML for cleaner analysis
    const plainText = articleHtml.replace(/<[^>]*>/g, '').trim();
    // Truncate if very long to stay within token limits
    const textForReview = plainText.substring(0, 8000);

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You are a biography consistency checker. Compare an article written "as" an author against their real personal detail bank. Look for:
1. CONTRADICTIONS: The article states something that conflicts with the author's known biography (e.g., says they have 3 kids when detail bank says 2)
2. FABRICATIONS: The article invents major life events (illness, divorce, death, career change, relocation) NOT in the detail bank
3. Minor everyday scenes (a conversation at a coffee shop, an observation on a walk) are FINE — only flag major biographical fabrications

Respond with a JSON object:
{"valid": true, "issues": []}
or
{"valid": false, "issues": ["Issue 1 description", "Issue 2 description"]}

Only flag genuine problems. If the article is clean, return valid: true with empty issues array.`,
      messages: [{
        role: 'user',
        content: `ARTICLE TITLE: "${articleTitle}"
AUTHOR: ${authorName}

AUTHOR'S PERSONAL DETAIL BANK:
${detailBank}

ARTICLE TEXT:
${textForReview}

Check for biography contradictions or major fabrications. Return JSON only.`
      }],
    });

    const text = resp.content[0]?.text?.trim();
    if (!text) return { valid: true, issues: [] };

    try {
      // Parse JSON from response (handle markdown code blocks)
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const result = JSON.parse(jsonStr);
      if (result.issues && result.issues.length > 0) {
        console.warn(`[BioValidator] Issues found for "${authorName}" in "${articleTitle}": ${result.issues.join('; ')}`);
      } else {
        console.log(`[BioValidator] Clean: "${authorName}" article passes biography check`);
      }
      return result;
    } catch (parseErr) {
      console.warn(`[BioValidator] Failed to parse Haiku response: ${text.substring(0, 200)}`);
      return { valid: true, issues: [] };
    }
  } catch (err) {
    console.warn(`[BioValidator] Validation failed (non-fatal): ${err.message}`);
    return { valid: true, issues: [] };
  }
}

export default validateBiography;
