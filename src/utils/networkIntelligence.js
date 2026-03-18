// Network Intelligence Service — shared across all content engines
// Queries Plausible across the entire media network to identify what topics,
// formats, and sources are driving traffic. Replaces per-engine competitor tracking
// with network-wide learning.
//
// Usage: import { getNetworkInsights } from '../utils/networkIntelligence.js';
// const insights = await getNetworkInsights('dmnews.com');
// Then feed insights.summary into title generation prompts.

import axios from 'axios';

// ==================== NETWORK CONFIGURATION ====================

const PLAUSIBLE_API = 'https://plausible.io/api/v2';

// All sites in the network with their slug prefix attribution
const NETWORK_SITES = {
  'geediting.com': {
    label: 'Geediting',
    engineSlugs: [],      // No engine on this site currently
    teamSlugs: {
      'j-a-': 'Justin Bot', 'gen-': 'Lachlan', 's-': 'Christy',
      'd-': 'Daniel', 'm-': 'Mal', 'gb-': 'Dad Bot', 'gbo-': 'Dad Bot Original',
      'jcb-': 'Jeanette Bot', 'r-': 'Ruda Bot',
      'a-': 'Team A', 'b-': 'Team B', 'k-': 'Team K', 'x-': 'Team X',
      'i-': 'Team I', 'z-': 'Team Z', 'c-': 'Team C', 'n-': 'Team N',
    },
    focus: 'psychology/lifestyle',
  },
  'dmnews.com': {
    label: 'DMNews',
    engineSlugs: ['dmn-'],
    teamSlugs: {
      'j-a-': 'Justin Bot', 'j-a-n-': 'Justin Bot News', 'gen-': 'Lachlan',
      's-': 'Christy', 'k-': 'Team K', 'kir-': 'Team Kir',
    },
    focus: 'psychology/culture/DM-framework',
  },
  'siliconcanals.com': {
    label: 'Silicon Canals',
    engineSlugs: ['sc-a-', 'sc-n-', 'sc-d-', 'sc-w-'],
    teamSlugs: {
      'j-a-': 'Justin Bot', 'gen-': 'Lachlan', 's-': 'Christy', 'k-': 'Team K',
    },
    focus: 'psychology/power/tech/business',
  },
  'vegoutmag.com': {
    label: 'VegOut',
    engineSlugs: ['vo-n-'],
    teamSlugs: {
      'j-a-': 'Justin Bot', 'jcb-': 'Jeanette Bot',
    },
    focus: 'plant-based/sustainability/wellness',
  },
  'tweakyourbiz.com': {
    label: 'TweakYourBiz',
    engineSlugs: ['tyb-d-', 'tyb-b-', 'tyb-t-'],
    teamSlugs: {
      'j-a-': 'Justin Bot',
    },
    focus: 'psychology/business/lifestyle',
  },
  'thevessel.io': {
    label: 'The Vessel',
    engineSlugs: [],
    teamSlugs: {
      'j-a-': 'Justin Bot', 'jcb-': 'Jeanette Bot', 'r-': 'Ruda Bot',
    },
    focus: 'personal-growth/mindfulness',
  },
  'experteditor.com.au': {
    label: 'Expert Editor',
    engineSlugs: [],
    teamSlugs: {
      'j-a-': 'Justin Bot', 'jcb-': 'Jeanette Bot',
    },
    focus: 'writing/education/language',
  },
  'artfulparent.com': {
    label: 'Artful Parent',
    engineSlugs: [],
    teamSlugs: {
      'j-a-': 'Justin Bot',
    },
    focus: 'parenting/creativity/family',
  },
};

// Traffic sources in Plausible
const TRAFFIC_SOURCES = {
  discover: { filter: ['is', 'visit:source', ['Google']], label: 'Google Discover' },
  googleNews: { filter: ['is', 'visit:source', ['Google News']], label: 'Google News' },
  // For social, we look at multiple sources
};

// ==================== PLAUSIBLE API CLIENT ====================

function createClient(apiKey) {
  return axios.create({
    baseURL: PLAUSIBLE_API,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

async function queryPlausible(client, siteId, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await client.post('/query', { site_id: siteId, ...body });
      return resp.data;
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message;
      const status = e.response?.status;
      if (attempt < retries && (status === 429 || status >= 500 || e.code === 'ECONNABORTED')) {
        console.warn(`[NetworkIntel] Query retry ${attempt + 1}/${retries} for ${siteId}: ${errMsg}`);
        await sleep(1000 * (attempt + 1)); // Exponential backoff
        continue;
      }
      console.warn(`[NetworkIntel] Query failed for ${siteId}: ${errMsg}`);
      return null;
    }
  }
  return null;
}

// ==================== CORE DATA FETCHERS ====================

/**
 * Get top pages by traffic source for a site.
 * Returns { page, visitors } sorted by visitors desc.
 */
async function getTopPagesBySource(client, siteId, sourceFilter, days = 7, limit = 100) {
  const body = {
    metrics: ['visitors'],
    dimensions: ['event:page'],
    date_range: `${days}d`,
    order_by: [['visitors', 'desc']],
    pagination: { limit },
  };
  if (sourceFilter) {
    body.filters = [sourceFilter];
  }
  const result = await queryPlausible(client, siteId, body);
  if (!result?.results) return [];
  return result.results.map(r => ({ page: r.dimensions[0], visitors: r.metrics[0] }));
}

/**
 * Get traffic by source for a site — breaks down where visitors come from.
 */
async function getSourceBreakdown(client, siteId, days = 7) {
  const result = await queryPlausible(client, siteId, {
    metrics: ['visitors'],
    dimensions: ['visit:source'],
    date_range: `${days}d`,
    order_by: [['visitors', 'desc']],
    pagination: { limit: 20 },
  });
  if (!result?.results) return [];
  return result.results.map(r => ({ source: r.dimensions[0], visitors: r.metrics[0] }));
}

/**
 * Filter pages to articles only (exclude homepage, categories, admin etc.)
 */
function filterToArticles(pages) {
  return pages.filter(a => {
    const p = a.page;
    if (!p || p === '/' || p.length < 5) return false;
    if (/^\/(wp-|admin|login|feed|page\/|category\/|tag\/|author\/|search|archive|newsletter|about|contact|privacy|terms|sitemap|the-direct-message|news\/?$)/.test(p)) return false;
    return p.split('/').filter(Boolean).some(seg => seg.includes('-') && seg.length > 5);
  });
}

/**
 * Extract the slug prefix from a page path.
 * e.g. /sc-a-some-article/ => 'sc-a-', /j-a-some-article/ => 'j-a-'
 */
function extractSlugPrefix(pagePath) {
  const slug = pagePath.replace(/^\//, '').replace(/\/$/, '');
  // Handle multi-segment paths like /news/vo-n-something
  const lastSegment = slug.split('/').pop();
  // Match known prefix patterns (1-4 letters followed by a dash, optionally repeated)
  const match = lastSegment.match(/^([a-z]{1,4}-(?:[a-z]{1,4}-)?)/);
  return match ? match[1] : null;
}

/**
 * Extract meaningful topic bigrams from a slug for topic analysis.
 * Uses 2-word phrases to capture actual topics rather than generic words.
 * e.g. /j-a-loneliness-in-modern-society/ => ['loneliness modern', 'modern society']
 */
function extractTopicPhrases(pagePath) {
  const slug = pagePath.replace(/^\//, '').replace(/\/$/, '');
  const lastSegment = slug.split('/').pop();
  // Remove the prefix (e.g. j-a-, sc-a-, dmn-, gen-bt-, etc.)
  const withoutPrefix = lastSegment.replace(/^[a-z]{1,4}-(?:[a-z]{1,4}-)?(?:[a-z]{1,4}-)?/, '');
  // Split on hyphens
  const words = withoutPrefix.split('-');

  // Stop words that appear in title slugs but carry no topic meaning
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
    'not', 'no', 'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'with', 'from',
    'by', 'about', 'into', 'out', 'up', 'down', 'over', 'under', 'between', 'through',
    'after', 'before', 'during', 'without', 'within', 'along', 'just', 'than',
    'very', 'really', 'actually', 'dont', 'arent', 'isnt', 'wont', 'cant',
    'youre', 'youve', 'heres', 'thats', 'whats', 'whos', 'ive', 'im',
    'says', 'say', 'said', 'people', 'ones', 'because', 'always', 'never',
    'every', 'most', 'more', 'some', 'many', 'much', 'often', 'still',
    'only', 'even', 'also', 'like', 'know', 'think', 'want', 'need',
    'make', 'get', 'got', 'take', 'come', 'go', 'tell', 'ask', 'way',
    'thing', 'things', 'something', 'nothing', 'everything', 'anyone',
    'someone', 'everyone', 'nobody', 'somebody', 'life', 'time', 'year', 'years',
    'psychology', 'psychologists', 'therapists', 'research', 'researchers',
    'explain', 'suggests', 'according', 'found', 'shows', 'reveals',
  ]);

  // Get meaningful words (4+ chars, not stop words)
  const meaningful = words.filter(w => w.length >= 4 && !stopWords.has(w));

  // Build bigrams from consecutive meaningful words
  const phrases = [];
  for (let i = 0; i < meaningful.length - 1; i++) {
    phrases.push(`${meaningful[i]} ${meaningful[i + 1]}`);
  }

  // Also include strong single keywords (5+ chars, likely topical)
  const strongSingles = meaningful.filter(w => w.length >= 6);
  for (const w of strongSingles) {
    phrases.push(w);
  }

  return phrases;
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==================== NETWORK INTELLIGENCE ====================

/**
 * Get network-wide insights for a specific engine.
 * This is the main entry point — call this from any engine's orchestrator.
 *
 * @param {string} mySiteId - The calling engine's Plausible site_id (e.g. 'dmnews.com')
 * @param {object} options
 * @param {string} options.apiKey - Plausible API key (from env)
 * @param {string[]} options.myEngineSlugs - This engine's slug prefixes (e.g. ['dmn-'])
 * @param {number} options.days - Lookback period (default 7)
 * @returns {object} Network insights with summary text for prompt injection
 */
export async function getNetworkInsights(mySiteId, options = {}) {
  const apiKey = options.apiKey || process.env.PLAUSIBLE_API_KEY;
  if (!apiKey) {
    console.warn('[NetworkIntel] No API key — returning empty insights');
    return { summary: '', data: null };
  }

  const client = createClient(apiKey);
  const days = options.days || 7;
  const myEngineSlugs = options.myEngineSlugs || NETWORK_SITES[mySiteId]?.engineSlugs || [];
  const mySiteConfig = NETWORK_SITES[mySiteId];

  console.log(`[NetworkIntel] Gathering insights across ${Object.keys(NETWORK_SITES).length} sites (${days}d lookback)...`);

  // ---- 1. Fetch data from all sites (batched to avoid rate limits) ----
  // Plausible has 600 req/hr limit. With 8 sites × 4 queries = 32 queries.
  // Batch in groups of 4 sites with small delays between batches.
  const siteEntries = Object.entries(NETWORK_SITES);
  const allSiteData = [];
  // Process sites sequentially with 4 parallel queries each.
  // This avoids hitting Plausible's rate limit (600 req/hr).
  // 8 sites × 4 queries = 32 total, well within limits when sequential.
  for (const [siteId, config] of siteEntries) {
    const [allPages, discoverPages, gnPages, sources] = await Promise.all([
      getTopPagesBySource(client, siteId, null, days, 150),
      getTopPagesBySource(client, siteId, TRAFFIC_SOURCES.discover.filter, days, 100),
      getTopPagesBySource(client, siteId, TRAFFIC_SOURCES.googleNews.filter, days, 100),
      getSourceBreakdown(client, siteId, days),
    ]);
    allSiteData.push({
      siteId,
      config,
      allPages: filterToArticles(allPages),
      discoverPages: filterToArticles(discoverPages),
      gnPages: filterToArticles(gnPages),
      sources,
    });
    await sleep(300); // Small pause between sites to be respectful
  }
  console.log(`[NetworkIntel] Fetched data from ${allSiteData.length} sites`);

  // ---- 2. Build topic frequency map across network (using bigrams + strong singles) ----
  const topicHits = {}; // phrase => { total, discover, gn, sites: Set, examples: [] }

  for (const site of allSiteData) {
    // Process top-performing articles (top 50 by visitors from all sources)
    const topArticles = site.allPages.slice(0, 50);
    for (const article of topArticles) {
      const phrases = extractTopicPhrases(article.page);
      for (const phrase of phrases) {
        if (!topicHits[phrase]) {
          topicHits[phrase] = { total: 0, discover: 0, gn: 0, sites: new Set(), examples: [] };
        }
        topicHits[phrase].total += article.visitors;
        topicHits[phrase].sites.add(site.siteId);
        if (topicHits[phrase].examples.length < 3) {
          topicHits[phrase].examples.push({ site: site.config.label, slug: article.page, visitors: article.visitors });
        }
      }
    }

    // Tag Discover traffic
    for (const article of site.discoverPages.slice(0, 30)) {
      const phrases = extractTopicPhrases(article.page);
      for (const phrase of phrases) {
        if (topicHits[phrase]) topicHits[phrase].discover += article.visitors;
      }
    }

    // Tag Google News traffic
    for (const article of site.gnPages.slice(0, 30)) {
      const phrases = extractTopicPhrases(article.page);
      for (const phrase of phrases) {
        if (topicHits[phrase]) topicHits[phrase].gn += article.visitors;
      }
    }
  }

  // ---- 3. Rank topics by total traffic across network ----
  const rankedTopics = Object.entries(topicHits)
    .map(([keyword, data]) => ({
      keyword,
      totalVisitors: data.total,
      discoverVisitors: data.discover,
      gnVisitors: data.gn,
      siteCount: data.sites.size,
      sites: Array.from(data.sites),
      examples: data.examples,
    }))
    .filter(t => t.siteCount >= 2 || t.totalVisitors >= 500) // Cross-site OR high-traffic
    .sort((a, b) => b.totalVisitors - a.totalVisitors);

  // ---- 4. Identify what's working by traffic source ----
  const discoverWinners = rankedTopics
    .filter(t => t.discoverVisitors > 100)
    .sort((a, b) => b.discoverVisitors - a.discoverVisitors)
    .slice(0, 15);

  const gnWinners = rankedTopics
    .filter(t => t.gnVisitors > 50)
    .sort((a, b) => b.gnVisitors - a.gnVisitors)
    .slice(0, 15);

  // ---- 5. My site: engine vs team performance ----
  const mySiteData = allSiteData.find(s => s.siteId === mySiteId);
  let enginePerf = null;
  let teamPerf = {};

  if (mySiteData && mySiteConfig) {
    // Engine articles
    const engineArticles = mySiteData.allPages.filter(a => {
      const prefix = extractSlugPrefix(a.page);
      return prefix && myEngineSlugs.some(ep => prefix.startsWith(ep));
    });

    enginePerf = {
      articles: engineArticles.length,
      totalVisitors: engineArticles.reduce((sum, a) => sum + a.visitors, 0),
      avgVisitors: engineArticles.length > 0
        ? Math.round(engineArticles.reduce((sum, a) => sum + a.visitors, 0) / engineArticles.length)
        : 0,
      topPerformers: engineArticles.slice(0, 5),
    };

    // Team member articles
    for (const [prefix, label] of Object.entries(mySiteConfig.teamSlugs)) {
      const teamArticles = mySiteData.allPages.filter(a => {
        const p = extractSlugPrefix(a.page);
        return p && p === prefix;
      });
      if (teamArticles.length > 0) {
        teamPerf[prefix] = {
          label,
          articles: teamArticles.length,
          totalVisitors: teamArticles.reduce((sum, a) => sum + a.visitors, 0),
          avgVisitors: Math.round(teamArticles.reduce((sum, a) => sum + a.visitors, 0) / teamArticles.length),
          topPerformers: teamArticles.slice(0, 3),
        };
      }
    }
  }

  // ---- 6. Cross-site top performers (articles others should learn from) ----
  const crossSiteTopPerformers = [];
  for (const site of allSiteData) {
    if (site.siteId === mySiteId) continue; // Skip own site
    // Top 5 articles from each other site
    for (const article of site.allPages.slice(0, 5)) {
      crossSiteTopPerformers.push({
        site: site.config.label,
        siteId: site.siteId,
        page: article.page,
        visitors: article.visitors,
        focus: site.config.focus,
      });
    }
  }
  crossSiteTopPerformers.sort((a, b) => b.visitors - a.visitors);

  // ---- 7. Traffic source mix per site (for understanding what works where) ----
  const sourceInsights = {};
  for (const site of allSiteData) {
    const totalVisitors = site.sources.reduce((sum, s) => sum + s.visitors, 0);
    const discoverVisitors = site.sources.filter(s => s.source === 'Google').reduce((sum, s) => sum + s.visitors, 0);
    const gnVisitors = site.sources.filter(s => s.source === 'Google News').reduce((sum, s) => sum + s.visitors, 0);
    const searchVisitors = site.sources.filter(s => ['Google', 'Bing', 'DuckDuckGo', 'Yahoo!'].includes(s.source) && s.source !== 'Google News').reduce((sum, s) => sum + s.visitors, 0);
    const socialVisitors = site.sources.filter(s => ['Facebook', 'Twitter', 'Instagram', 'Pinterest', 'LinkedIn', 'Reddit', 't.co', 'youtube.com'].includes(s.source)).reduce((sum, s) => sum + s.visitors, 0);

    sourceInsights[site.siteId] = {
      label: site.config.label,
      total: totalVisitors,
      discover: discoverVisitors,
      googleNews: gnVisitors,
      search: searchVisitors,
      social: socialVisitors,
      topSource: site.sources[0]?.source || 'unknown',
    };
  }

  // ---- 8. Build summary text for prompt injection ----
  const summary = buildInsightsSummary({
    mySiteId,
    mySiteConfig,
    rankedTopics: rankedTopics.slice(0, 20),
    discoverWinners: discoverWinners.slice(0, 10),
    gnWinners: gnWinners.slice(0, 10),
    enginePerf,
    teamPerf,
    crossSiteTopPerformers: crossSiteTopPerformers.slice(0, 15),
    sourceInsights,
    days,
  });

  const data = {
    rankedTopics: rankedTopics.slice(0, 30),
    discoverWinners: discoverWinners.slice(0, 15),
    gnWinners: gnWinners.slice(0, 15),
    enginePerf,
    teamPerf,
    crossSiteTopPerformers: crossSiteTopPerformers.slice(0, 20),
    sourceInsights,
  };

  console.log(`[NetworkIntel] Generated insights: ${rankedTopics.length} trending topics, ${discoverWinners.length} Discover winners, ${gnWinners.length} GN winners`);

  return { summary, data };
}

// ==================== SUMMARY BUILDER ====================

function buildInsightsSummary({ mySiteId, mySiteConfig, rankedTopics, discoverWinners, gnWinners, enginePerf, teamPerf, crossSiteTopPerformers, sourceInsights, days }) {
  let s = '';

  // --- Network-wide traffic source overview ---
  s += `=== NETWORK INTELLIGENCE (${days}-day lookback across ${Object.keys(sourceInsights).length} sites) ===\n\n`;

  s += `TRAFFIC SOURCE MIX ACROSS NETWORK:\n`;
  for (const [siteId, data] of Object.entries(sourceInsights)) {
    if (data.total < 10) continue;
    const discoverPct = data.total > 0 ? Math.round((data.discover / data.total) * 100) : 0;
    const gnPct = data.total > 0 ? Math.round((data.googleNews / data.total) * 100) : 0;
    s += `  ${data.label}: ${data.total.toLocaleString()} total — Discover ${discoverPct}%, GNews ${gnPct}%, top source: ${data.topSource}\n`;
  }
  s += '\n';

  // --- Topics that work across network ---
  if (rankedTopics.length > 0) {
    s += `WINNING TOPICS ACROSS NETWORK (cross-site patterns):\n`;
    for (const t of rankedTopics.slice(0, 12)) {
      const sources = [];
      if (t.discoverVisitors > 100) sources.push(`Discover: ${t.discoverVisitors}`);
      if (t.gnVisitors > 50) sources.push(`GNews: ${t.gnVisitors}`);
      s += `  - "${t.keyword}" — ${t.totalVisitors.toLocaleString()} visitors across ${t.siteCount} sites${sources.length ? ` (${sources.join(', ')})` : ''}\n`;
    }
    s += '\n';
  }

  // --- Discover-specific winners ---
  if (discoverWinners.length > 0) {
    s += `GOOGLE DISCOVER WINNING TOPICS:\n`;
    for (const t of discoverWinners.slice(0, 8)) {
      s += `  - "${t.keyword}" (${t.discoverVisitors} Discover visitors, ${t.siteCount} sites)\n`;
    }
    s += `  → Discover rewards: emotional/psychological titles, curiosity gaps, personal relevance\n\n`;
  }

  // --- Google News winners ---
  if (gnWinners.length > 0) {
    s += `GOOGLE NEWS WINNING TOPICS:\n`;
    for (const t of gnWinners.slice(0, 8)) {
      s += `  - "${t.keyword}" (${t.gnVisitors} GNews visitors, ${t.siteCount} sites)\n`;
    }
    s += `  → Google News rewards: timely hooks, specific claims, data-driven angles\n\n`;
  }

  // --- Cross-site top performers ---
  if (crossSiteTopPerformers.length > 0) {
    s += `TOP PERFORMERS FROM OTHER NETWORK SITES (learn from these):\n`;
    for (const p of crossSiteTopPerformers.slice(0, 10)) {
      const slug = p.page.replace(/^\//, '').replace(/-/g, ' ').substring(0, 60);
      s += `  - [${p.site}] "${slug}" (${p.visitors.toLocaleString()} visitors)\n`;
    }
    s += '\n';
  }

  // --- Engine vs team on this site ---
  if (enginePerf && Object.keys(teamPerf).length > 0) {
    s += `YOUR PERFORMANCE vs TEAM ON ${mySiteConfig?.label || mySiteId}:\n`;
    s += `  Engine: ${enginePerf.articles} articles, avg ${enginePerf.avgVisitors} visitors/article\n`;

    const sortedTeam = Object.entries(teamPerf)
      .sort((a, b) => b[1].avgVisitors - a[1].avgVisitors);

    for (const [prefix, data] of sortedTeam) {
      const comparison = enginePerf.avgVisitors > 0
        ? (data.avgVisitors > enginePerf.avgVisitors ? '⚠️ BEATING YOU' : '✓ you lead')
        : '';
      s += `  ${data.label} (${prefix}*): ${data.articles} articles, avg ${data.avgVisitors} visitors ${comparison}\n`;
    }

    // Overall target
    const teamAvg = sortedTeam.length > 0
      ? Math.round(sortedTeam.reduce((sum, [, d]) => sum + d.avgVisitors, 0) / sortedTeam.length)
      : 0;
    if (teamAvg > 0) {
      const gap = enginePerf.avgVisitors - teamAvg;
      if (gap < 0) {
        s += `\n  ⚠️ ENGINE IS ${Math.abs(gap)} visitors/article BELOW team average (${teamAvg}). Focus on quality over volume.\n`;
      } else {
        s += `\n  ✓ Engine is ${gap} visitors/article ABOVE team average (${teamAvg}). Keep pushing.\n`;
      }
    }
    s += '\n';
  }

  // --- Strategic guidance ---
  s += `STRATEGY: Use network insights to inform title choices. Topics working on multiple sites have proven audience demand. `;
  s += `Optimize for ALL traffic sources — don't over-index on just one. `;
  s += `~85% proven patterns, ~15% experimental.\n`;

  return s;
}

// ==================== LIGHTWEIGHT SINGLE-SITE FETCH ====================

/**
 * Quick fetch for a single site's top pages by source.
 * Useful for engines that also want to check their own site independently.
 */
export async function getSiteTopPerformers(siteId, options = {}) {
  const apiKey = options.apiKey || process.env.PLAUSIBLE_API_KEY;
  if (!apiKey) return [];

  const client = createClient(apiKey);
  const days = options.days || 7;
  const sourceFilter = options.sourceFilter || null;

  return getTopPagesBySource(client, siteId, sourceFilter, days, options.limit || 50);
}

/**
 * Get the source breakdown for a single site.
 */
export async function getSiteSourceBreakdown(siteId, options = {}) {
  const apiKey = options.apiKey || process.env.PLAUSIBLE_API_KEY;
  if (!apiKey) return [];

  const client = createClient(apiKey);
  return getSourceBreakdown(client, siteId, options.days || 7);
}

// Export config for engines to reference
export { NETWORK_SITES, TRAFFIC_SOURCES };
