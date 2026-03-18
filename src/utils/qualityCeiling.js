// Quality ceiling — scores full article content before publishing
// Uses Claude Haiku for fast evaluation on prose quality dimensions.
// Articles below threshold get one rewrite attempt; if still below, publish as draft.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const MIN_QUALITY_SCORE = 6;  // Articles scoring below this trigger a rewrite
const DRAFT_THRESHOLD = 5;     // After rewrite, still below this → publish as draft

/**
 * Score an article's prose quality on multiple dimensions.
 *
 * @param {string} content - Full HTML article content
 * @param {string} title - Article title
 * @param {string} authorName - Author pen name
 * @param {string} contentFormat - Format type (news_brief, feature, opinion, longform)
 * @returns {{ score: number, dimensions: Object, reasoning: string, passed: boolean }}
 */
export async function scoreArticleQuality(content, title, authorName, contentFormat) {
  // News briefs have lower bar — they're meant to be short and factual
  const threshold = contentFormat === 'news_brief' ? 5 : MIN_QUALITY_SCORE;

  try {
    // Strip HTML for cleaner evaluation
    const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Send first 4000 chars — enough to judge quality without burning tokens
    const sample = plainText.length > 4000 ? plainText.substring(0, 4000) + '...' : plainText;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You are a senior magazine editor evaluating article quality for DMNews.com. Score this article on 6 dimensions, each 1-10. Be HARSH — a 7 should mean genuinely good writing, not "acceptable."

DIMENSIONS:
1. Opening Hook (1-10): Does the first paragraph pull you in with a specific scene, person, or tension? Generic openings ("In today's world...") = 3 or below.
2. Prose Flow (1-10): Does it read like flowing magazine prose? Or does it feel like AI-generated content with predictable paragraph structure? Look for: varied sentence length, natural transitions, personality in the voice.
3. Depth & Insight (1-10): Does it go beyond surface observations? Does it name specific psychological concepts, cite real research, or reveal something the reader didn't already know?
4. Character Specificity (1-10): Are there named characters with ages, occupations, cities? Or is it all abstract "many people" and "experts say"?
5. Source Integration (1-10): Are claims backed by inline links to real sources? Or is it unsourced assertion after unsourced assertion?
6. Voice Authenticity (1-10): Does this feel like ${authorName} wrote it — with their specific perspective, quirks, and expertise? Or could any generic writer have produced this?

FINAL SCORE = Average of all 6 dimensions, rounded to 1 decimal.

Score 7-10 = Publish-worthy
Score 6 = Borderline — could use improvement
Score 1-5 = Below standard — needs rewrite

Respond with ONLY a JSON object:
{
  "opening": N, "proseFlow": N, "depth": N, "characters": N, "sources": N, "voice": N,
  "overall": N,
  "weakest": "dimension name",
  "reasoning": "one sentence on the biggest quality issue"
}`,
      messages: [{
        role: 'user',
        content: `Title: "${title}"
Author: ${authorName}
Format: ${contentFormat}

ARTICLE TEXT:
${sample}

Score this article's prose quality.`,
      }],
    });

    let text = (resp.content[0]?.text || '').trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const result = JSON.parse(text);
    const overall = Math.round(result.overall * 10) / 10;

    console.log(`[QualityCeiling] "${title.substring(0, 50)}..." → ${overall}/10 (weakest: ${result.weakest || 'n/a'})`);

    return {
      score: overall,
      dimensions: {
        opening: result.opening || 0,
        proseFlow: result.proseFlow || 0,
        depth: result.depth || 0,
        characters: result.characters || 0,
        sources: result.sources || 0,
        voice: result.voice || 0,
      },
      weakest: result.weakest || '',
      reasoning: result.reasoning || '',
      passed: overall >= threshold,
    };
  } catch (e) {
    console.warn(`[QualityCeiling] Scoring failed for "${title}": ${e.message} — passing by default`);
    return { score: 0, dimensions: {}, weakest: '', reasoning: `Scoring failed: ${e.message}`, passed: true };
  }
}

/**
 * Build a rewrite instruction based on quality score dimensions.
 */
export function buildRewriteGuidance(qualityResult) {
  const { dimensions, weakest, reasoning } = qualityResult;
  const issues = [];

  if (dimensions.opening <= 5) issues.push('OPENING: Start with a specific named person, scene, or moment — not a generic observation.');
  if (dimensions.proseFlow <= 5) issues.push('PROSE: Vary sentence length. Use shorter punchy sentences between longer ones. Avoid predictable paragraph structures.');
  if (dimensions.depth <= 5) issues.push('DEPTH: Name specific psychological concepts or research findings. Go beyond surface-level observations.');
  if (dimensions.characters <= 5) issues.push('CHARACTERS: Add 2-3 named characters with specific ages, occupations, and cities. Real-feeling people, not abstractions.');
  if (dimensions.sources <= 5) issues.push('SOURCES: Weave in references to specific studies, reports, or expert quotes with inline links.');
  if (dimensions.voice <= 5) issues.push('VOICE: Write with more personality. Add the specific quirks and perspective of the author.');

  return `QUALITY REWRITE REQUIRED. The previous draft scored ${qualityResult.score}/10. Main issue: ${reasoning}\n\nSPECIFIC FIXES NEEDED:\n${issues.length > 0 ? issues.join('\n') : `Focus on improving: ${weakest}`}`;
}

export { MIN_QUALITY_SCORE, DRAFT_THRESHOLD };
