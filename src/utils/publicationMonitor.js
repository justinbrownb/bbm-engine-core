// Publication Monitor — Reads from reputable publications, fetches full text, triages via Claude Haiku
// Provides rich research briefs for content engines

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';

const client = new Anthropic();
const rssParser = new RssParser();

// Configuration of publications organized by lanes they serve
const MONITORED_PUBLICATIONS = {
  psychology: [
    {
      name: 'The Conversation',
      feedUrl: 'https://theconversation.com/us/articles.atom',
      domains: ['theconversation.com'],
    },
    {
      name: 'Greater Good (Berkeley)',
      feedUrl: 'https://greatergood.berkeley.edu/feed/rss',
      domains: ['greatergood.berkeley.edu'],
    },
    {
      name: 'PsyPost',
      feedUrl: 'https://www.psypost.org/feed/',
      domains: ['psypost.org'],
    },
    {
      name: 'NPR Health',
      feedUrl: 'https://feeds.npr.org/1128/rss.xml',
      domains: ['npr.org'],
    },
    {
      name: 'BBC Health',
      feedUrl: 'http://feeds.bbci.co.uk/news/health/rss.xml',
      domains: ['bbc.com', 'bbc.co.uk'],
    },
    {
      name: 'Healthline',
      feedUrl: 'https://www.healthline.com/rss',
      domains: ['healthline.com'],
    },
    {
      name: 'Medical News Today',
      feedUrl: 'https://rss.medicalnewstoday.com/featurednews.xml',
      domains: ['medicalnewstoday.com'],
    },
    {
      name: 'Psychology Today',
      feedUrl: 'https://www.psychologytoday.com/us/blog/feed',
      domains: ['psychologytoday.com'],
    },
  ],
  entertainment: [
    {
      name: 'Soompi',
      feedUrl: 'https://www.soompi.com/feed/',
      domains: ['soompi.com'],
    },
    {
      name: 'AllKPop',
      feedUrl: 'https://www.allkpop.com/rss',
      domains: ['allkpop.com'],
    },
    {
      name: 'Billboard',
      feedUrl: 'https://www.billboard.com/feed/',
      domains: ['billboard.com'],
    },
    {
      name: 'Variety',
      feedUrl: 'https://variety.com/feed/',
      domains: ['variety.com'],
    },
    {
      name: 'People',
      feedUrl: 'https://people.com/feed/',
      domains: ['people.com'],
    },
    {
      name: 'Deadline',
      feedUrl: 'https://deadline.com/feed/',
      domains: ['deadline.com'],
    },
  ],
  lifestyle: [
    {
      name: 'Vox',
      feedUrl: 'https://www.vox.com/rss/index.xml',
      domains: ['vox.com'],
    },
    {
      name: 'HuffPost Life',
      feedUrl: 'https://www.huffpost.com/section/healthy-living/feed',
      domains: ['huffpost.com'],
    },
    {
      name: 'BuzzFeed',
      feedUrl: 'https://www.buzzfeed.com/index.xml',
      domains: ['buzzfeed.com'],
    },
    {
      name: 'Today.com',
      feedUrl: 'https://www.today.com/rss',
      domains: ['today.com'],
    },
    {
      name: 'Refinery29',
      feedUrl: 'https://www.refinery29.com/rss.xml',
      domains: ['refinery29.com'],
    },
    {
      name: 'Times of India Life & Style',
      feedUrl: 'https://timesofindia.indiatimes.com/rssfeeds/2886704.cms',
      domains: ['timesofindia.indiatimes.com'],
    },
    {
      name: 'Times of India Health',
      feedUrl: 'https://timesofindia.indiatimes.com/rssfeeds/3908999.cms',
      domains: ['timesofindia.indiatimes.com'],
    },
    {
      name: 'Times of India Most Shared',
      feedUrl: 'https://timesofindia.indiatimes.com/rssfeeds/32459498.cms',
      domains: ['timesofindia.indiatimes.com'],
    },
  ],
  general: [
    {
      name: 'Times of India Entertainment',
      feedUrl: 'https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms',
      domains: ['timesofindia.indiatimes.com'],
    },
  ],
};

/**
 * Fetch articles from a single RSS feed
 * Returns array of { title, url, source, pubDate, summary, feedLane }
 */
async function fetchRSSFeed(publication, lane) {
  try {
    const feed = await rssParser.parseURL(publication.feedUrl);
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    return (feed.items || []).slice(0, 10).map(item => {
      const pubTime = new Date(item.pubDate || item.isoDate || Date.now()).getTime();
      return {
        title: item.title?.trim() || '',
        url: item.link || '',
        source: publication.name,
        pubDate: item.pubDate || item.isoDate || '',
        summary: item.summary?.replace(/<[^>]*>/g, '').substring(0, 300) || item.contentSnippet || '',
        feedLane: lane,
        publishedWithinDay: pubTime >= oneDayAgo,
      };
    }).filter(a => a.publishedWithinDay && a.url && a.title);
  } catch (e) {
    console.error(`[PublicationMonitor] RSS fetch failed for ${publication.name}: ${e.message}`);
    return [];
  }
}

/**
 * Scan publications by lane
 * Takes array of lane names, returns all articles from monitored publications within last 24h
 * Returns array of { title, url, source, pubDate, summary, lane }
 * Max 10 per publication, total cap 100
 */
export async function scanPublications(lanes = ['psychology', 'entertainment', 'lifestyle']) {
  console.log(`[PublicationMonitor] Scanning publications for lanes: ${lanes.join(', ')}`);

  const allArticles = [];
  const articlesPerPub = 10;
  const totalCap = 100;

  for (const lane of lanes) {
    const publications = MONITORED_PUBLICATIONS[lane] || [];

    for (const pub of publications) {
      if (allArticles.length >= totalCap) break;

      const articles = await fetchRSSFeed(pub, lane);
      allArticles.push(...articles.slice(0, articlesPerPub));

      // Small delay between requests to be respectful to servers
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (allArticles.length >= totalCap) break;
  }

  console.log(`[PublicationMonitor] Scanned and found ${allArticles.length} articles from publications`);
  return allArticles.slice(0, totalCap);
}

/**
 * Triage articles using Claude Haiku
 * Evaluates newsworthiness, audience fit, uniqueness, timeliness
 * Returns top N articles where N = targetCount * 3, each with relevance score
 */
export async function triageArticles(articles, targetCount = 5, performanceContext = '') {
  if (!articles || articles.length === 0) {
    console.log('[PublicationMonitor] No articles to triage');
    return [];
  }

  console.log(`[PublicationMonitor] Triaging ${articles.length} articles with target count ${targetCount}`);

  const articlesToTriage = articles.slice(0, 30); // Triage max 30 to avoid huge context
  const articlesList = articlesToTriage
    .map((a, i) => `${i + 1}. "${a.title}" (${a.source}, ${a.lane})\n   ${a.summary}`)
    .join('\n');

  const prompt = `You are a news editor triaging articles for quality, newsworthiness, and audience fit.

${performanceContext ? `PERFORMANCE CONTEXT:\n${performanceContext}\n` : ''}

ARTICLES TO TRIAGE:
${articlesList}

EVALUATE each article on:
- Newsworthiness (is this a genuine insight, not just gossip or rehashed news?)
- Audience fit (does this matter to readers interested in psychology, entertainment, or lifestyle?)
- Uniqueness (is this covered elsewhere already, or does it offer a fresh angle?)
- Timeliness (is this breaking/immediate or is it a timeless insight?)
- Writability (can we write a 1000-1500 word article from this?)

Return ONLY a JSON array (no markdown, no explanation) with exactly ${Math.min(targetCount * 3, articles.length)} objects:
[
  { index: <number>, score: <1-10>, reason: "<brief one-line reason>" }
]

Sort by score descending. Return ONLY valid JSON.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      console.error('[PublicationMonitor] Failed to parse Haiku triage response');
      return articles.slice(0, Math.min(targetCount * 3, articles.length));
    }

    const triaged = JSON.parse(jsonMatch[0]);
    const result = triaged
      .slice(0, Math.min(targetCount * 3, articles.length))
      .map(t => ({
        ...articlesToTriage[t.index - 1],
        relevanceScore: t.score,
        triageReason: t.reason,
      }));

    console.log(`[PublicationMonitor] Triaged to ${result.length} promising articles`);
    return result;
  } catch (e) {
    console.error(`[PublicationMonitor] Triage failed: ${e.message}`);
    return articles.slice(0, Math.min(targetCount * 3, articles.length));
  }
}

/**
 * Fetch article text AND extract hyperlinks from URL using cheerio
 * Returns { text, links } where links are URLs found within the article content
 * Links from the source articles become secondary sources we can cite
 */
async function fetchArticleContent(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBot/1.0)' },
      maxRedirects: 3,
    });

    const $ = cheerio.load(resp.data);

    // Remove noise
    $('script, style, nav, header, footer, aside, .sidebar, .ad, .advertisement, .social-share, .comments, .related-posts, .newsletter-signup').remove();

    // Try common content selectors
    const contentSelectors = [
      '.entry-content',
      '.post-content',
      '.article-body',
      '.article-content',
      'article',
      '[itemprop="articleBody"]',
      '.story-body',
      '.content-body',
      'main',
      '.prose',
      '.article',
    ];

    let contentEl = null;
    let text = '';
    for (const sel of contentSelectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 200) {
        contentEl = el;
        text = el.text().trim();
        break;
      }
    }

    // Fallback: collect all paragraphs
    if (!text || text.length < 200) {
      const paragraphs = [];
      $('p').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 40) paragraphs.push(t);
      });
      text = paragraphs.join('\n\n');
    }

    // Extract hyperlinks from article content — these are sources the article cites
    const links = [];
    const seenUrls = new Set();
    const linkSource = contentEl || $('body');
    linkSource.find('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const anchorText = $(el).text().trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      // Skip internal nav links, social links, and ad links
      if (href.includes('/tag/') || href.includes('/category/') || href.includes('/author/')) return;
      if (href.includes('twitter.com') || href.includes('facebook.com') || href.includes('instagram.com')) return;
      if (href.includes('mailto:')) return;
      // Skip links from the same domain as the source article
      try {
        const articleDomain = new URL(url).hostname.replace('www.', '');
        const linkDomain = new URL(href, url).hostname.replace('www.', '');
        if (linkDomain === articleDomain) return;
      } catch { /* invalid URL, skip */ return; }
      // Resolve relative URLs
      let fullUrl = href;
      try { fullUrl = new URL(href, url).href; } catch { return; }
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);
      if (anchorText.length > 3 && anchorText.length < 200) {
        links.push({ url: fullUrl, text: anchorText });
      }
    });

    return { text: text.substring(0, 15000), links: links.slice(0, 15) };
  } catch (e) {
    console.error(`[PublicationMonitor] Failed to fetch article content from ${url}: ${e.message}`);
    return null;
  }
}

/**
 * Extract sources from article text using Claude Haiku
 * Returns array of { claim, sourceUrl, sourceName }
 */
async function extractSources(articleText, articleUrl) {
  if (!articleText || articleText.length < 100) {
    return [];
  }

  try {
    const prompt = `Extract all factual claims, statistics, research findings, and expert quotes from this article text. For each claim, identify:
1. The specific claim or statistic
2. Any URLs cited as sources (if present in the text)
3. The source organization/expert name (if mentioned)

Article text (first 8000 chars):
${articleText.substring(0, 8000)}

Return ONLY valid JSON (no markdown) in this format:
{
  "sources": [
    { "claim": "...", "sourceUrl": "...", "sourceName": "..." },
    ...
  ]
}

If no sources are explicitly cited in the text, return empty sources array. Keep claims concise (1-2 sentences max).`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.sources || []).slice(0, 10);
  } catch (e) {
    console.error(`[PublicationMonitor] Failed to extract sources: ${e.message}`);
    return [];
  }
}

/**
 * Summarize article using Claude Haiku
 * Returns { keyFacts, keyQuotes, statistics, summary }
 */
async function summarizeArticle(articleText) {
  if (!articleText || articleText.length < 100) {
    return { keyFacts: [], keyQuotes: [], statistics: [], summary: '' };
  }

  try {
    const prompt = `Summarize this article in a structured way for a content writer. Extract:
1. Key facts and main claims (bullet points, max 5)
2. Key quotes from experts/officials (max 3)
3. Statistics and data points mentioned (max 5)
4. One-paragraph summary of the core insight

Article (first 10000 chars):
${articleText.substring(0, 10000)}

Return ONLY valid JSON (no markdown):
{
  "keyFacts": ["...", "...", ...],
  "keyQuotes": [{ "quote": "...", "attribution": "..." }, ...],
  "statistics": ["...", "...", ...],
  "summary": "..."
}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return { keyFacts: [], keyQuotes: [], statistics: [], summary: '' };
    }

    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`[PublicationMonitor] Failed to summarize article: ${e.message}`);
    return { keyFacts: [], keyQuotes: [], statistics: [], summary: '' };
  }
}

/**
 * Fetch and summarize triaged articles
 * Returns enriched articles with fullText, summary, extracted sources
 * Handles failures gracefully — includes article even if fetch fails
 */
export async function fetchAndSummarize(triagedArticles) {
  if (!triagedArticles || triagedArticles.length === 0) {
    console.log('[PublicationMonitor] No articles to fetch and summarize');
    return [];
  }

  console.log(`[PublicationMonitor] Fetching and summarizing ${triagedArticles.length} articles`);

  const enriched = [];

  for (const article of triagedArticles.slice(0, 10)) {
    console.log(`[PublicationMonitor] Processing: ${article.source} — ${article.title.substring(0, 60)}`);

    const content = await fetchArticleContent(article.url);
    const fullText = content?.text || null;
    const articleLinks = content?.links || [];

    let summary = {};
    let sources = [];

    if (fullText) {
      summary = await summarizeArticle(fullText);
      sources = await extractSources(fullText, article.url);
      // Small delay between Claude calls
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    enriched.push({
      ...article,
      fullText,
      articleLinks, // hyperlinks found within the source article — secondary sources
      summary,
      extractedSources: sources,
    });
  }

  console.log(`[PublicationMonitor] Enriched ${enriched.length} articles`);
  return enriched;
}

/**
 * Build a research brief from enriched articles
 * Combines summaries into a single reference document for writers
 * Format includes stories, sources, and key insights
 */
export function buildResearchBrief(enrichedArticles, lane = 'general') {
  if (!enrichedArticles || enrichedArticles.length === 0) {
    return `PUBLICATION RESEARCH BRIEF — ${lane}\nNo articles to summarize.`;
  }

  const sourcesSet = new Set();
  let storiesSectionParts = [];
  const allSourceUrls = []; // collect all source URLs for the writer

  for (const [idx, article] of enrichedArticles.entries()) {
    const storyNum = idx + 1;
    const sourceInfo = article.source ? ` (via ${article.source})` : '';

    let storySection = `=== STORY ${storyNum}: ${article.title}${sourceInfo} ===\n`;
    // PRIMARY SOURCE: The article URL itself — this MUST be linked in the final article
    storySection += `Source URL: ${article.url}\n`;
    allSourceUrls.push({ url: article.url, title: article.title, source: article.source, type: 'primary' });

    if (article.summary) {
      if (article.summary.summary) {
        storySection += `Summary: ${article.summary.summary}\n`;
      }
      if (article.summary.keyFacts && article.summary.keyFacts.length > 0) {
        storySection += `Key claims: ${article.summary.keyFacts.join('; ')}\n`;
      }
      if (article.summary.statistics && article.summary.statistics.length > 0) {
        storySection += `Statistics: ${article.summary.statistics.join('; ')}\n`;
      }
      if (article.summary.keyQuotes && article.summary.keyQuotes.length > 0) {
        const quotesStr = article.summary.keyQuotes
          .map(q => `"${q.quote}" — ${q.attribution}`)
          .join('; ');
        storySection += `Quotes: ${quotesStr}\n`;
      }
    }

    if (article.extractedSources && article.extractedSources.length > 0) {
      const sourcesStr = article.extractedSources
        .map(s => {
          const url = s.sourceUrl ? ` (${s.sourceUrl})` : '';
          sourcesSet.add(s.sourceName || 'Unknown');
          if (s.sourceUrl) allSourceUrls.push({ url: s.sourceUrl, title: s.claim, source: s.sourceName, type: 'cited' });
          return `${s.claim} — ${s.sourceName || 'Unknown'}${url}`;
        })
        .join('; ');
      storySection += `Sources cited in article: ${sourcesStr}\n`;
    }

    // SECONDARY SOURCES: Links found within the source article — trustworthy references
    if (article.articleLinks && article.articleLinks.length > 0) {
      const linksStr = article.articleLinks
        .slice(0, 8)
        .map(l => `${l.text} — ${l.url}`)
        .join('; ');
      storySection += `Links from article: ${linksStr}\n`;
      for (const l of article.articleLinks.slice(0, 8)) {
        allSourceUrls.push({ url: l.url, title: l.text, source: article.source, type: 'secondary' });
      }
    }

    storySection += '\n';
    storiesSectionParts.push(storySection);
  }

  const sourcesList = Array.from(sourcesSet).join(', ');
  const publicationNames = [...new Set(enrichedArticles.map(a => a.source).filter(Boolean))].join(', ');
  const header = `PUBLICATION RESEARCH BRIEF — ${lane.toUpperCase()}\nBased on ${enrichedArticles.length} articles from ${publicationNames || sourcesList}\n\n`;

  // Add a VERIFIED SOURCES block at the end — the writer MUST use these as inline hyperlinks
  let sourcesBlock = '';
  if (allSourceUrls.length > 0) {
    const uniqueUrls = [];
    const seen = new Set();
    for (const s of allSourceUrls) {
      if (!seen.has(s.url)) {
        seen.add(s.url);
        uniqueUrls.push(s);
      }
    }
    sourcesBlock = `\n=== VERIFIED SOURCES — USE THESE AS INLINE HYPERLINKS ===\n`;
    sourcesBlock += `CRITICAL: You MUST weave these URLs as inline hyperlinks throughout the article. Every major claim should link to one of these sources.\n`;
    for (const s of uniqueUrls) {
      const label = s.type === 'primary' ? '[PRIMARY — must link]' : s.type === 'cited' ? '[CITED]' : '[SECONDARY]';
      sourcesBlock += `${label} ${s.title || s.source} — ${s.url}\n`;
    }
    sourcesBlock += '\n';
  }

  const storiesSection = storiesSectionParts.join('');

  return header + storiesSection + sourcesBlock;
}

/**
 * Search for articles on a specific topic from news RSS sources
 * Used by /write handlers and bot news mode
 * Searches Google News RSS + Bing News RSS, fetches full text, builds research brief
 *
 * @param {string} topic - Topic to search for
 * @param {number} maxArticles - Max articles to process (default 5)
 * @returns {Promise<{brief: string, enriched: Array, sourceArticles: Array}|null>}
 */
export async function searchTopicInPublications(topic, maxArticles = 5) {
  console.log(`[PublicationMonitor] Searching publications for topic: "${topic}"`);

  // 1. Search for topic across news RSS sources
  const discovered = await searchNewsRSS(topic, maxArticles * 3);
  if (discovered.length === 0) {
    console.log(`[PublicationMonitor] No articles found for topic: "${topic}"`);
    return null;
  }

  console.log(`[PublicationMonitor] Found ${discovered.length} articles for "${topic}"`);

  // 2. Triage for relevance and quality
  const triaged = await triageArticles(discovered, maxArticles);
  if (triaged.length === 0) {
    console.log(`[PublicationMonitor] No articles passed triage for "${topic}"`);
    return null;
  }

  // 3. Fetch full text, extract links, summarize
  const enriched = await fetchAndSummarize(triaged.slice(0, maxArticles));
  if (enriched.length === 0) {
    console.log(`[PublicationMonitor] No articles had extractable content for "${topic}"`);
    return null;
  }

  // 4. Build research brief with source URLs
  const brief = buildResearchBrief(enriched, 'topic-search');

  // 5. Collect source article URLs for tracking
  const sourceArticles = enriched.map(a => ({
    url: a.url,
    title: a.title,
    source: a.source,
  }));

  console.log(`[PublicationMonitor] Built research brief from ${enriched.length} articles for "${topic}"`);
  return { brief, enriched, sourceArticles };
}

/**
 * Search Google News RSS + Bing News RSS for a specific topic
 * Returns array of article objects compatible with triageArticles
 */
async function searchNewsRSS(topic, limit = 15) {
  const results = [];
  const seenUrls = new Set();

  // Helper to add unique results
  const addResults = (articles) => {
    for (const a of articles) {
      if (!seenUrls.has(a.url) && a.url && a.title) {
        seenUrls.add(a.url);
        results.push(a);
      }
    }
  };

  // Search Bing News RSS (primary — resolvable URLs)
  try {
    const encodedTopic = encodeURIComponent(topic);
    const bingUrl = `https://www.bing.com/news/search?q=${encodedTopic}&format=rss`;
    const bingResp = await axios.get(bingUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const $bing = cheerio.load(bingResp.data, { xmlMode: true });
    $bing('item').each((i, el) => {
      if (i >= limit) return false;
      const title = $bing(el).find('title').text().trim();
      const url = $bing(el).find('link').text().trim();
      const pubDate = $bing(el).find('pubDate').text().trim();
      const description = $bing(el).find('description').text().trim();
      let source = 'Unknown';
      const sourceMatch = title.match(/ - ([^-]+)$/);
      if (sourceMatch) source = sourceMatch[1].trim();
      // Extract real URL from Bing redirect
      let realUrl = url;
      try {
        const urlObj = new URL(url);
        const redirectUrl = urlObj.searchParams.get('url');
        if (redirectUrl) realUrl = redirectUrl;
      } catch { /* use original */ }
      if (realUrl && !realUrl.includes('bing.com')) {
        addResults([{
          title: sourceMatch ? title.replace(/ - [^-]+$/, '').trim() : title,
          url: realUrl,
          source,
          pubDate,
          summary: description.replace(/<[^>]*>/g, '').substring(0, 300),
          feedLane: 'topic-search',
          publishedWithinDay: true,
        }]);
      }
    });
    console.log(`[PublicationMonitor] Bing News: ${results.length} articles for "${topic}"`);
  } catch (e) {
    console.warn(`[PublicationMonitor] Bing News search failed: ${e.message}`);
  }

  // Search Google News RSS (secondary)
  try {
    const encodedTopic = encodeURIComponent(topic);
    const gnUrl = `https://news.google.com/rss/search?q=${encodedTopic}&hl=en-US&gl=US&ceid=US:en`;
    const gnResp = await axios.get(gnUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const $gn = cheerio.load(gnResp.data, { xmlMode: true });
    $gn('item').each((i, el) => {
      if (i >= limit) return false;
      const title = $gn(el).find('title').text().trim();
      const pubDate = $gn(el).find('pubDate').text().trim();
      const sourceEl = $gn(el).find('source');
      const source = sourceEl.text().trim() || 'Unknown';
      const sourceUrl = sourceEl.attr('url') || '';
      // Try to extract real URL from description HTML
      const descHtml = $gn(el).find('description').text().trim();
      let realUrl = '';
      if (descHtml) {
        const $desc = cheerio.load(descHtml);
        const firstLink = $desc('a').first().attr('href');
        if (firstLink && !firstLink.includes('news.google.com')) {
          realUrl = firstLink;
        }
      }
      const url = realUrl || sourceUrl;
      // Filter out homepage URLs (no meaningful path) and Google News redirects
      let isValidArticleUrl = false;
      if (url && !url.includes('news.google.com')) {
        try {
          const parsed = new URL(url);
          // Must have a path beyond just "/" to be an actual article
          isValidArticleUrl = parsed.pathname.length > 1;
        } catch { isValidArticleUrl = false; }
      }
      if (isValidArticleUrl) {
        addResults([{
          title: title.replace(/ - .*$/, '').trim(),
          url,
          source,
          pubDate,
          summary: '',
          feedLane: 'topic-search',
          publishedWithinDay: true,
        }]);
      }
    });
    console.log(`[PublicationMonitor] Google News: ${results.length} total articles for "${topic}"`);
  } catch (e) {
    console.warn(`[PublicationMonitor] Google News search failed: ${e.message}`);
  }

  return results.slice(0, limit);
}

export default {
  scanPublications,
  triageArticles,
  fetchAndSummarize,
  buildResearchBrief,
  searchTopicInPublications,
};
