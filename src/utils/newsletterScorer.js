// Newsletter quality scorer — rates articles for newsletter worthiness
// Uses Claude Haiku for quick scoring after article is written.
// Score 8+ = flagged as newsletter candidate, stored in WP post meta.
//
// Unified version: accepts flexible params object. Each engine passes what it has.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

/**
 * Score an article for newsletter worthiness.
 *
 * @param {Object} params
 * @param {string} params.title - Article title
 * @param {string} [params.content] - Article HTML content (first ~2000 chars used)
 * @param {string} [params.excerpt] - Article excerpt
 * @param {string} [params.tier] - Content tier (psychology, adjacent, news, deepdive, worldEvents)
 * @param {string} [params.contentFormat] - Article format (news_brief, feature, opinion, longform)
 * @param {string} [params.dmTension] - DM Framework tension (DMNews-specific)
 * @param {string} [params.dmNoise] - DM Framework noise (DMNews-specific)
 * @param {string} [params.dmDirectMessage] - DM Framework direct message (DMNews-specific)
 * @param {string} params.authorName - Author name
 * @param {string} params.systemPrompt - Newsletter-specific scoring system prompt
 * @param {string} [params.userContext] - Additional user context for the scoring prompt
 * @returns {{ score: number, reasoning: string, isNewsletterCandidate: boolean }}
 */
export async function scoreForNewsletter({
  title,
  content,
  excerpt,
  tier,
  contentFormat,
  dmTension,
  dmNoise,
  dmDirectMessage,
  authorName,
  systemPrompt,
  userContext,
}) {
  // Skip scoring for news briefs or very short content
  if (contentFormat === 'news_brief') {
    return { score: 0, reasoning: 'News briefs are not scored for newsletter', isNewsletterCandidate: false };
  }
  if (content && content.length < 2000 && !excerpt) {
    return { score: 0, reasoning: 'Article too short for newsletter consideration', isNewsletterCandidate: false };
  }

  // Default system prompt if none provided
  const defaultSystemPrompt = `You are a newsletter editor. Score this article 1-10 for newsletter worthiness.

SCORING CRITERIA:
- Originality (1-10): Does this offer a genuinely fresh perspective?
- Structural Insight (1-10): Does this reveal patterns or dynamics others miss?
- Reader Value (1-10): Will readers feel smarter after reading this?
- Writing Quality (1-10): Is this publication-quality prose?
- Shareability (1-10): Would someone forward this to their network?

FINAL SCORE = Average of all 5 dimensions, rounded.

Score 8-10 = Newsletter featured piece
Score 6-7 = Good but not newsletter-worthy
Score 1-5 = Standard content

Respond with ONLY a JSON object: { "score": N, "reasoning": "one sentence" }`;

  try {
    // Build user message from whatever params are available
    const contentExcerpt = content
      ? content.replace(/<[^>]+>/g, '').substring(0, 2000)
      : excerpt || 'N/A';

    let userMessage = `Title: "${title}"\nAuthor: ${authorName}`;
    if (tier) userMessage += `\nTier: ${tier}`;
    if (contentFormat) userMessage += `\nFormat: ${contentFormat}`;
    if (contentExcerpt) userMessage += `\nContent excerpt: ${contentExcerpt}`;
    if (dmTension) userMessage += `\nTension: ${dmTension}`;
    if (dmNoise) userMessage += `\nNoise: ${dmNoise}`;
    if (dmDirectMessage) userMessage += `\nDirect Message: ${dmDirectMessage}`;
    if (userContext) userMessage += `\n${userContext}`;
    userMessage += `\n\nScore this article for newsletter worthiness.`;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt || defaultSystemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let text = (resp.content[0]?.text || '').trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const result = JSON.parse(text);
    const score = Math.min(10, Math.max(1, Math.round(result.score || 0)));

    console.log(`[NewsletterScorer] "${title.substring(0, 50)}..." → ${score}/10 (${result.reasoning || 'no reasoning'})`);

    return {
      score,
      reasoning: result.reasoning || '',
      isNewsletterCandidate: score >= 8,
    };
  } catch (e) {
    console.warn(`[NewsletterScorer] Scoring failed for "${title}": ${e.message}`);
    return { score: 0, reasoning: `Scoring failed: ${e.message}`, isNewsletterCandidate: false };
  }
}
