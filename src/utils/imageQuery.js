/**
 * SMART IMAGE QUERY GENERATOR
 *
 * Uses Claude Haiku to generate editorial-quality stock photo search queries
 * instead of dumb keyword extraction. This prevents:
 * - Irrelevant images (monkeys for psychology articles)
 * - Generic/repetitive results for similar topics
 * - Queries that don't match editorial intent
 *
 * Cost: ~$0.001 per query (Haiku is cheap)
 */

import Anthropic from '@anthropic-ai/sdk';

let anthropicClient = null;

function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Generate a smart Pexels search query for an article.
 *
 * @param {string} title - The article title
 * @param {string} searchHints - Optional hints from the writer
 * @returns {Promise<string>} A targeted 3-6 word search query
 */
export async function generateImageQuery(title, searchHints = '') {
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `You generate stock photo search queries for Pexels.com for news/magazine article feature images.

ARTICLE TITLE: "${title}"
${searchHints ? `WRITER'S HINT: "${searchHints}"` : ''}

Generate a SHORT (3-6 words) search query that would find a high-quality, editorial-appropriate stock photo for this article's feature image.

RULES:
- Think about what VISUAL would represent this story editorially — the mood, setting, or concept
- For psychology/behavior articles: search for the HUMAN EMOTION or SITUATION, not the scientific concept (e.g., "person thoughtful window reflection" NOT "behavioral science laboratory")
- For technology/AI articles: search for clean tech imagery (e.g., "modern office technology screen" NOT "artificial intelligence robot")
- For business/finance: search for professional settings or abstract finance imagery
- For politics/geopolitics: search for landmarks, flags, institutions — NOT specific politicians
- For food/wellness: search for the specific food/activity described
- For surveillance/privacy: "security camera urban street" NOT abstract concepts
- NEVER search for specific named people — stock sites won't have them
- NEVER use abstract/academic terms like "behavioral", "neurological", "geopolitical" — these return garbage on stock sites
- Prefer CONCRETE, VISUAL terms: places, objects, actions, settings, moods
- Each query should be UNIQUE to this specific article — different articles about similar topics should get different queries

Reply with ONLY the search query, nothing else.`
      }],
    });

    const query = (response.content[0]?.text || '').trim().replace(/['"]/g, '');
    if (query && query.length > 2 && query.length < 80) {
      console.log(`[ImageQuery] Smart query for "${title.substring(0, 50)}..." → "${query}"`);
      return query;
    }
  } catch (e) {
    console.warn(`[ImageQuery] Haiku query generation failed: ${e.message}`);
  }

  // Fallback: basic keyword extraction (same as before, but better than nothing)
  return fallbackQuery(title, searchHints);
}

/**
 * Generate a fallback search query for inline images (simpler, faster).
 * These don't need to be as precise since they supplement the feature image.
 */
export function generateInlineImageQuery(query) {
  // For inline images, the query is already provided by the writer
  // Just clean it up
  return query.replace(/[^a-zA-Z0-9\s]/g, '').trim() || 'professional lifestyle';
}

/**
 * Fallback query builder when Haiku is unavailable.
 * Extracts meaningful keywords and adds contextual cues.
 */
function fallbackQuery(title, searchHints = '') {
  const lower = title.toLowerCase();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
    'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and',
    'but', 'or', 'not', 'so', 'yet', 'if', 'than', 'too', 'very', 'just', 'about',
    'how', 'what', 'when', 'where', 'who', 'which', 'why', 'this', 'that', 'these',
    'those', 'it', 'they', 'them', 'their', 'we', 'us', 'our', 'you', 'your',
    'he', 'him', 'his', 'she', 'her', 'my', 'me', 'says', 'said', 'new', 'also',
    'now', 'get', 'gets', 'got', 'going', 'know', 'like', 'make', 'many', 'much',
    'one', 'two', 'first', 'last', 'things', 'people', 'according', 'really',
    'actually', 'every', 'never', 'always', 'without', 'before', 'after',
    'between', 'most', 'more', 'dont', 'cant', 'wont', 'youre', 'theyre',
  ]);

  const words = lower.replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  const keywords = [...new Set(words)].slice(0, 3);

  // Add contextual mood
  let mood = '';
  if (/lonely|alone|solitud/.test(lower)) mood = 'contemplative solitude';
  else if (/happy|joy|smile/.test(lower)) mood = 'happy smiling';
  else if (/money|financ|wealth/.test(lower)) mood = 'business finance';
  else if (/food|eat|diet|cook|vegan|plant/.test(lower)) mood = 'food cooking';
  else if (/tech|ai |digital|software/.test(lower)) mood = 'technology modern';
  else mood = 'person lifestyle';

  const parts = [...keywords, mood, searchHints].filter(Boolean);
  return parts.join(' ').trim() || 'person lifestyle editorial';
}
