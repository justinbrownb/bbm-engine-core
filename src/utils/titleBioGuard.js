// Title Bio Guard — Layer 1: Filter generated titles against author's detail bank
// Runs BEFORE ranking to remove titles that contradict known biographical facts
// Uses Claude Haiku for fast, cheap batch filtering

import Anthropic from '@anthropic-ai/sdk';
import { personalDetailBanks } from '../data/personalDetails.js';

const anthropic = new Anthropic();

/**
 * Extract key biographical facts from a detail bank for title-level checking.
 * Focuses on: marital status, family (alive/dead), age, career, location, health.
 */
function extractKeyFacts(detailBank) {
  if (!detailBank) return null;

  // Pull lines that contain key biographical markers
  const lines = detailBank.split('\n').filter(l => l.trim().length > 0);
  const keyPatterns = [
    /wife|husband|partner|spouse|married|divorced|widowed|single/i,
    /child|daughter|son|kids|baby|grandchild|grandson|granddaughter/i,
    /died|death|passed away|deceased|funeral|cancer|illness|diagnosis/i,
    /age|born|\byears? old\b|\b\d{2}\b.*years/i,
    /retired|career|job|profession|work|employment/i,
    /lives? in|moved to|relocated|based in/i,
  ];

  const keyLines = lines.filter(line =>
    keyPatterns.some(p => p.test(line))
  );

  // Return a condensed version — max ~2000 chars to keep Haiku call fast
  const condensed = keyLines.slice(0, 30).join('\n');
  return condensed || null;
}

/**
 * Filter an array of titles against an author's biographical detail bank.
 * Removes titles that would require the author to have experiences contradicting their real life.
 *
 * @param {string} authorName - Full name of the author
 * @param {string[]} titles - Array of title strings to filter
 * @returns {Promise<{ passed: string[], dropped: { title: string, reason: string }[] }>}
 */
export async function filterTitlesByBio(authorName, titles) {
  const detailBank = personalDetailBanks[authorName];
  if (!detailBank) {
    // No detail bank = can't filter, pass all through
    return { passed: titles, dropped: [] };
  }

  const keyFacts = extractKeyFacts(detailBank);
  if (!keyFacts) {
    return { passed: titles, dropped: [] };
  }

  try {
    const titleList = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are a biography consistency checker for article titles. Given an author's key biographical facts and a list of proposed article titles written "as" that author (first person), identify any titles that CONTRADICT the author's known biography.

A title contradicts biography if:
- It implies the author is widowed/divorced when they're married (or vice versa)
- It implies children/grandchildren the author doesn't have (or denies ones they do)
- It implies an age range that doesn't match the author
- It implies a career/profession the author never had
- It implies a life event (death, illness, divorce) that contradicts known facts
- It implies a gender or family structure that contradicts known facts

DO NOT flag titles just because they're about a sensitive topic. Only flag if the title REQUIRES the author to have a biographical detail that contradicts their real life.

Respond with ONLY a JSON array. For each title, return:
{"index": 1, "pass": true} if the title is fine
{"index": 1, "pass": false, "reason": "brief reason"} if the title contradicts biography

Return ONLY the JSON array.`,
      messages: [{
        role: 'user',
        content: `AUTHOR: ${authorName}

KEY BIOGRAPHICAL FACTS:
${keyFacts}

PROPOSED TITLES:
${titleList}

Check each title for biographical contradictions. Return JSON array.`,
      }],
    });

    const text = resp.content[0]?.text?.trim();
    if (!text) return { passed: titles, dropped: [] };

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { passed: titles, dropped: [] };

    const results = JSON.parse(jsonMatch[0]);

    const passed = [];
    const dropped = [];

    for (let i = 0; i < titles.length; i++) {
      const result = results.find(r => r.index === i + 1) || results[i];
      if (result && result.pass === false) {
        dropped.push({ title: titles[i], reason: result.reason || 'biographical contradiction' });
        console.log(`[TitleBioGuard] DROPPED: "${titles[i].substring(0, 80)}..." — ${result.reason || 'biographical contradiction'}`);
      } else {
        passed.push(titles[i]);
      }
    }

    if (dropped.length > 0) {
      console.log(`[TitleBioGuard] ${dropped.length}/${titles.length} titles dropped for ${authorName}`);
    } else {
      console.log(`[TitleBioGuard] All ${titles.length} titles passed bio check for ${authorName}`);
    }

    return { passed, dropped };
  } catch (err) {
    console.warn(`[TitleBioGuard] Filter failed (non-fatal): ${err.message}`);
    return { passed: titles, dropped: [] };
  }
}

export default filterTitlesByBio;
