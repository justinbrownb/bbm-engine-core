// Story-level deduplication — prevents publishing multiple articles about the same underlying story
// Uses Claude Haiku to extract story signatures from trending headlines,
// then filters out stories we've already covered recently (cross-day aware).

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

/**
 * Extract story signatures from a list of trending headlines.
 * Groups headlines into distinct underlying stories and returns story keys.
 *
 * @param {Array} headlines - Array of { title, source } objects
 * @returns {Array} Array of { storyKey, headlines: [...], theme } objects
 */
export async function extractStorySignatures(headlines) {
  if (!headlines || headlines.length === 0) return [];

  const headlineList = headlines
    .slice(0, 50) // Cap at 50 to keep prompt size reasonable
    .map((h, i) => `${i + 1}. ${h.title} (${h.source || 'unknown'})`)
    .join('\n');

  const systemPrompt = `You are a news deduplication engine. Your job is to group trending headlines into DISTINCT underlying stories.

RULES:
- Two headlines about the same event, study, or topic = SAME story (even if angles differ)
- A "story" is the underlying news event or topic, not the angle or framing
- Generate a short story key (3-5 lowercase words, hyphenated) that captures the core story
- Headlines that are genuinely about different topics = DIFFERENT stories
- Be aggressive about grouping — if headlines are about the same research study, company announcement, or event, they're the same story

RESPOND WITH ONLY a JSON array:
[
  { "storyKey": "openai-new-model-launch", "theme": "brief description", "headlineIndices": [1, 4, 7] },
  { "storyKey": "saudi-tech-fund-investment", "theme": "brief description", "headlineIndices": [2, 5] },
  ...
]`;

  const userMessage = `Group these headlines into distinct underlying stories:\n\n${headlineList}\n\nReturn ONLY the JSON array.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let text = resp.content[0]?.text || '';
    text = text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const stories = JSON.parse(text);
    console.log(`[StoryDedup] Grouped ${headlines.length} headlines into ${stories.length} distinct stories`);
    return stories;
  } catch (e) {
    console.error(`[StoryDedup] Story extraction failed: ${e.message}`);
    // Fallback: treat each headline as its own story
    return headlines.map((h, i) => ({
      storyKey: h.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40),
      theme: h.title,
      headlineIndices: [i + 1],
    }));
  }
}

/**
 * Filter out stories that have already been published today.
 *
 * @param {Array} stories - Array from extractStorySignatures
 * @param {Array} publishedStoryKeys - Array of story keys already published today
 * @returns {Array} Filtered stories (only new ones)
 */
export function filterNewStories(stories, publishedStoryKeys = []) {
  if (!publishedStoryKeys || publishedStoryKeys.length === 0) return stories;

  const publishedSet = new Set(publishedStoryKeys.map(k => k.toLowerCase()));

  const newStories = stories.filter(story => {
    const key = story.storyKey.toLowerCase();
    // Check exact match
    if (publishedSet.has(key)) {
      console.log(`[StoryDedup] Skipping already-covered story: "${story.storyKey}"`);
      return false;
    }
    // Check partial overlap (if enough words match between keys)
    const keyWords = new Set(key.split('-').filter(w => w.length > 2));
    for (const published of publishedSet) {
      const pubWords = new Set(published.split('-').filter(w => w.length > 2));
      const overlap = [...keyWords].filter(w => pubWords.has(w)).length;
      const minSize = Math.min(keyWords.size, pubWords.size);
      // For short keys (3-4 words): 2+ overlap = duplicate
      // For longer keys (5+ words): 3+ overlap = duplicate
      const overlapThreshold = minSize <= 4 ? 2 : 3;
      if (overlap >= overlapThreshold) {
        console.log(`[StoryDedup] Skipping similar story: "${story.storyKey}" (${overlap} word overlap with "${published}")`);
        return false;
      }
    }
    return true;
  });

  console.log(`[StoryDedup] ${stories.length} stories → ${newStories.length} new (${stories.length - newStories.length} already covered)`);
  return newStories;
}

/**
 * Build filtered trend data that only includes headlines from new (uncovered) stories.
 * This is the main integration point — call this between discoverTrends() and generateTitles().
 *
 * @param {Object} trendData - Original trend data from discoverTrends()
 * @param {Array} publishedStoryKeys - Story keys already published today
 * @returns {Object} Modified trendData with duplicate stories removed
 */
export async function deduplicateTrends(trendData, publishedStoryKeys = []) {
  if (!trendData || !trendData.opportunities) return trendData;

  // Collect all headlines across all lanes
  const allHeadlines = [];
  const headlineMap = new Map(); // index → { lane, headlineIndex }

  for (const opp of trendData.opportunities) {
    for (let i = 0; i < opp.headlines.length; i++) {
      const globalIdx = allHeadlines.length;
      allHeadlines.push(opp.headlines[i]);
      headlineMap.set(globalIdx + 1, { lane: opp.lane, headlineIndex: i }); // 1-indexed for Claude
    }
  }

  if (allHeadlines.length === 0) return trendData;

  // Extract story signatures
  const stories = await extractStorySignatures(allHeadlines);

  // Filter to only new stories
  const newStories = filterNewStories(stories, publishedStoryKeys);

  // Build set of headline indices that belong to new stories
  const allowedIndices = new Set();
  for (const story of newStories) {
    for (const idx of story.headlineIndices) {
      allowedIndices.add(idx);
    }
  }

  // Filter trend data to only include headlines from new stories
  const filteredTrendData = {
    ...trendData,
    opportunities: trendData.opportunities.map(opp => {
      const filteredHeadlines = opp.headlines.filter((h, i) => {
        // Find this headline's global index
        for (const [globalIdx, mapping] of headlineMap.entries()) {
          if (mapping.lane === opp.lane && mapping.headlineIndex === i) {
            return allowedIndices.has(globalIdx);
          }
        }
        return true; // Keep if we can't find it (safety fallback)
      });

      return {
        ...opp,
        headlines: filteredHeadlines,
        themes: opp.themes, // Keep themes — they're useful context even if some headlines filtered
      };
    }),
    totalHeadlines: allowedIndices.size,
  };

  // Collect new story keys for the orchestrator to track
  filteredTrendData._newStoryKeys = newStories.map(s => s.storyKey);

  return filteredTrendData;
}

/**
 * Generate a simple story key from a title without an API call.
 * Used for tracking story keys after each publish (lightweight, no Haiku cost).
 *
 * @param {string} title - Article title
 * @returns {string} Simple story key (hyphenated lowercase)
 */
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'your', 'what', 'when', 'have', 'been',
  'just', 'most', 'than', 'more', 'they', 'into', 'about', 'will', 'could', 'would', 'should',
  'here', 'there', 'their', 'these', 'those', 'does', 'doing', 'being', 'were', 'some', 'every',
  'also', 'each', 'much', 'many', 'very', 'really', 'actually', 'according', 'people', 'says',
  'said', 'explains', 'explain', 'shows', 'show', 'reveals', 'reveal', 'finds', 'find', 'found',
  'study', 'research', 'according', 'experts', 'scientists', 'researchers', 'psychologists',
  'makes', 'make', 'made', 'like', 'know', 'think', 'want', 'need', 'take', 'give', 'come',
  'look', 'only', 'over', 'such', 'after', 'before', 'between', 'back', 'well', 'even', 'still',
  'never', 'aren', 'didn', 'isn', 'doesn', 'don', 'won', 'can', 'might']);

export function generateStoryKey(title) {
  if (!title) return '';
  return title.toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 5)
    .join('-');
}

/**
 * Deduplicate an array of publication-monitor articles against already-published titles.
 * Uses Haiku to semantically group BOTH incoming articles AND recently published titles together,
 * so any incoming article about the same underlying story as a published title gets filtered out.
 *
 * @param {Array} articles - Array of article objects with .title property
 * @param {Array} publishedStoryKeys - Story keys already published (legacy, kept for compat)
 * @param {Array} publishedTitles - Recently published article titles (for semantic matching)
 * @returns {Array} Filtered articles with duplicates removed
 */
/**
 * Extract significant words from a title for keyword matching.
 * Keeps words >2 chars, strips punctuation, lowercases, removes common stop words.
 * Also extracts compound terms like "GLP-1", "COVID-19" as single tokens.
 */
function extractKeywords(title) {
  if (!title) return new Set();
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
    'our', 'out', 'has', 'have', 'been', 'will', 'more', 'when', 'who', 'this', 'that', 'with',
    'from', 'they', 'were', 'than', 'what', 'their', 'said', 'each', 'which', 'does', 'into',
    'just', 'about', 'also', 'most', 'some', 'your', 'very', 'after', 'before', 'being', 'could',
    'would', 'should', 'there', 'where', 'these', 'those', 'other', 'every', 'still', 'here',
    'many', 'much', 'over', 'under', 'between', 'through', 'because', 'while', 'during',
    'says', 'according', 'study', 'found', 'shows', 'new', 'may', 'how', 'why', 'didn',
    'isn', 'aren', 'doesn', 'don', 'won', 'nobody', 'ever', 'never', 'really', 'actually',
  ]);

  // Extract compound terms first (e.g., GLP-1, COVID-19)
  const compounds = (title.match(/[A-Za-z]+-\d+/g) || []).map(c => c.toLowerCase());

  const words = title
    .toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  const keywords = new Set([...words, ...compounds]);
  return keywords;
}

export async function deduplicateArticles(articles, publishedStoryKeys = [], publishedTitles = []) {
  if (!articles || articles.length === 0) return [];

  const recentPublished = (publishedTitles || []).slice(-200);
  console.log(`[StoryDedup] Dedup input: ${articles.length} incoming articles, ${recentPublished.length} published titles, ${(publishedStoryKeys || []).length} story keys`);

  // ===== LAYER 1: LOCAL KEYWORD MATCHING (guaranteed, no API dependency) =====
  // If an incoming article shares 3+ significant keywords with any published title, it's a duplicate
  const publishedKeywordSets = recentPublished.map(t => ({
    title: t,
    keywords: extractKeywords(t),
  }));

  const localFiltered = [];
  const localRemoved = [];

  for (const article of articles) {
    const articleKeywords = extractKeywords(article.title);
    let isDuplicate = false;
    let bestMatch = null;
    let bestOverlap = 0;

    for (const pub of publishedKeywordSets) {
      const overlap = [...articleKeywords].filter(w => pub.keywords.has(w));
      if (overlap.length > bestOverlap) {
        bestOverlap = overlap.length;
        bestMatch = pub.title;
      }
      // Threshold: 3+ shared keywords = duplicate
      if (overlap.length >= 3) {
        isDuplicate = true;
        console.log(`[StoryDedup] LOCAL MATCH: "${article.title.substring(0, 60)}..." ↔ "${pub.title.substring(0, 60)}..." (${overlap.length} shared: ${overlap.slice(0, 5).join(', ')})`);
        break;
      }
    }

    if (isDuplicate) {
      localRemoved.push(article.title);
    } else {
      localFiltered.push(article);
    }
  }

  if (localRemoved.length > 0) {
    console.log(`[StoryDedup] Layer 1 (local keywords): removed ${localRemoved.length} duplicates, ${localFiltered.length} remaining`);
  }

  // ===== LAYER 2: WITHIN-BATCH DEDUP (local — no two articles about same story in one batch) =====
  const batchFiltered = [];
  const seenBatchKeywords = [];

  for (const article of localFiltered) {
    const articleKeywords = extractKeywords(article.title);
    let isBatchDupe = false;

    for (const prev of seenBatchKeywords) {
      const overlap = [...articleKeywords].filter(w => prev.keywords.has(w));
      if (overlap.length >= 3) {
        isBatchDupe = true;
        console.log(`[StoryDedup] BATCH DUPE: "${article.title.substring(0, 60)}..." ↔ "${prev.title.substring(0, 60)}..." (${overlap.length} shared)`);
        break;
      }
    }

    if (!isBatchDupe) {
      batchFiltered.push(article);
      seenBatchKeywords.push({ title: article.title, keywords: articleKeywords });
    }
  }

  if (batchFiltered.length < localFiltered.length) {
    console.log(`[StoryDedup] Layer 2 (within-batch): removed ${localFiltered.length - batchFiltered.length} batch duplicates`);
  }

  // ===== LAYER 3: HAIKU SEMANTIC MATCHING (bonus layer — catches subtle semantic dupes) =====
  // This is a best-effort layer. If it fails, we still have layers 1 and 2.
  let finalFiltered = batchFiltered;

  if (batchFiltered.length > 0 && recentPublished.length > 0) {
    try {
      const combinedList = [
        ...batchFiltered.map(a => `[NEW] ${a.title}`),
        ...recentPublished.slice(-30).map(t => `[PUBLISHED] ${t}`),
      ];

      const headlineList = combinedList
        .slice(0, 80)
        .map((h, i) => `${i + 1}. ${h}`)
        .join('\n');

      const incomingCount = batchFiltered.length;
      const publishedCount = Math.min(recentPublished.length, 30);

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `You are a news deduplication engine. Headlines tagged [NEW] (incoming) or [PUBLISHED] (already published).
Group ALL headlines about the same underlying event/study/topic into the SAME story — regardless of tag.
Different angles on same news = same story. Be VERY aggressive about grouping.
RESPOND WITH ONLY a JSON array: [{ "storyKey": "topic-key", "headlineIndices": [1, 4, 7] }, ...]`,
        messages: [{ role: 'user', content: `Group these headlines:\n\n${headlineList}\n\nReturn ONLY JSON array.` }],
      });

      let text = resp.content[0]?.text || '';
      text = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const stories = JSON.parse(text);

      const publishedStart = incomingCount + 1;
      const publishedEnd = incomingCount + publishedCount;
      const allowedIndices = new Set();

      for (const story of stories) {
        const indices = story.headlineIndices || [];
        const hasPublished = indices.some(idx => idx >= publishedStart && idx <= publishedEnd);
        const newIndices = indices.filter(idx => idx >= 1 && idx <= incomingCount);

        if (hasPublished) {
          console.log(`[StoryDedup] HAIKU MATCH: "${story.storyKey}" — already published (skipping ${newIndices.length} new articles)`);
        } else if (newIndices.length > 0) {
          allowedIndices.add(newIndices[0]); // Only first per story group
        }
      }

      finalFiltered = batchFiltered.filter((_, i) => allowedIndices.has(i + 1));

      if (finalFiltered.length < batchFiltered.length) {
        console.log(`[StoryDedup] Layer 3 (Haiku semantic): removed ${batchFiltered.length - finalFiltered.length} additional duplicates`);
      }
    } catch (e) {
      console.warn(`[StoryDedup] Layer 3 (Haiku) failed (non-fatal, layers 1+2 still applied): ${e.message}`);
      // Layers 1 and 2 already applied — Haiku failure is non-critical
      finalFiltered = batchFiltered;
    }
  }

  const totalRemoved = articles.length - finalFiltered.length;
  if (totalRemoved > 0) {
    console.log(`[StoryDedup] TOTAL: filtered ${totalRemoved} duplicates from ${articles.length} (${finalFiltered.length} remaining)`);
  } else {
    console.log(`[StoryDedup] No duplicates found in ${articles.length} articles`);
  }

  return finalFiltered;
}

/**
 * Generate story keys from recently published article titles.
 * Uses Claude Haiku to extract story signatures from our own published titles,
 * so we can avoid re-covering the same underlying stories across days.
 *
 * @param {Array} articles - Array of { title, slug, date } from WordPress
 * @returns {Array} Array of story key strings
 */
export async function extractKeysFromPublished(articles) {
  if (!articles || articles.length === 0) return [];

  const titleList = articles
    .slice(0, 60)
    .map((a, i) => `${i + 1}. ${a.title}`)
    .join('\n');

  const systemPrompt = `You extract story keys from published article titles. A story key is a short 3-5 word hyphenated lowercase label capturing the CORE underlying story or event (not the angle).

RULES:
- Multiple articles about the same event/topic → same story key
- Be aggressive about grouping: "OpenAI closes $40B round" and "OpenAI closes $10B round" are the SAME story (openai-funding-round)
- "ChatGPT Health fails medical tests" and "ChatGPT health feature dangerous" are the SAME story (chatgpt-health-failures)
- Focus on the underlying news event, not the framing

RESPOND WITH ONLY a JSON array of unique story key strings:
["openai-funding-round", "chatgpt-health-failures", "saudi-tech-fund", ...]`;

  const userMessage = `Extract unique story keys from these recently published titles:\n\n${titleList}\n\nReturn ONLY the JSON array of unique story key strings.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let text = resp.content[0]?.text || '';
    text = text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const keys = JSON.parse(text);
    console.log(`[StoryDedup] Extracted ${keys.length} story keys from ${articles.length} published articles`);
    return keys.filter(k => typeof k === 'string');
  } catch (e) {
    console.error(`[StoryDedup] Published key extraction failed: ${e.message}`);
    // Fallback: generate simple keys from titles
    return articles.map(a =>
      a.title.toLowerCase()
        .replace(/[''""]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['this', 'that', 'with', 'from', 'your', 'what', 'when', 'have', 'been', 'just', 'most', 'than', 'more', 'they', 'into', 'about'].includes(w))
        .slice(0, 4)
        .join('-')
    ).filter(k => k.length > 5);
  }
}
