// Publication Discovery — Dynamic publication following for DMN engine
// Auto-discovers mid-tier publishers producing viral content
// Adapts the publication list over time based on performance

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';

const client = new Anthropic();
const rssParser = new RssParser();

// Big publishers to exclude (top-tier, static authority)
const BIG_PUBLISHERS_BLOCKLIST = [
  'nytimes.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com',
  'apnews.com', 'wsj.com', 'washingtonpost.com', 'theguardian.com',
  'ft.com', 'bloomberg.com', 'nbcnews.com', 'abc.com', 'foxnews.com',
  'cbsnews.com', 'politico.com', 'vice.com', 'businessinsider.com',
  'techcrunch.com', 'wired.com', 'arstechnica.com', 'engadget.com',
];

/**
 * Discover new publications based on winning topics from network intelligence
 * @param {Object} networkInsights - From getNetworkInsights(): contains summary, topTopics, etc.
 * @param {Array} currentPublications - Already-monitored publications to avoid duplicates
 * @returns {Array} Candidate publications with { name, feedUrl, domains, lane, discoveredFrom }
 */
export async function discoverNewPublications(networkInsights, currentPublications) {
  if (!networkInsights || !networkInsights.topTopics || networkInsights.topTopics.length === 0) {
    return [];
  }

  const currentDomains = new Set();
  (currentPublications.active || []).forEach(pub => {
    pub.domains?.forEach(d => currentDomains.add(d.toLowerCase()));
  });

  const candidates = [];
  const processedUrls = new Set();

  // Search Google News RSS for each top topic
  for (const topic of networkInsights.topTopics.slice(0, 5)) {
    try {
      const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic.name)}`;
      const feed = await rssParser.parseURL(searchUrl);

      // Extract unique source domains from results
      const sourceDomainsInTopic = new Set();
      (feed.items || []).slice(0, 20).forEach(item => {
        if (item.link) {
          try {
            const url = new URL(item.link);
            const domain = url.hostname.toLowerCase().replace(/^www\./, '');
            sourceDomainsInTopic.add(domain);
          } catch {}
        }
      });

      // Evaluate each domain for mid-tier publisher status
      for (const domain of sourceDomainsInTopic) {
        if (currentDomains.has(domain) || BIG_PUBLISHERS_BLOCKLIST.includes(domain)) {
          continue;
        }

        if (processedUrls.has(domain)) {
          continue;
        }
        processedUrls.add(domain);

        // Attempt to find RSS feed
        const feedUrl = await findRssFeedForDomain(domain);
        if (!feedUrl) continue;

        // Evaluate if mid-tier
        const isMidTier = await evaluateMidTierStatus(domain);
        if (!isMidTier) continue;

        candidates.push({
          name: formatPublicationName(domain),
          feedUrl,
          domains: [domain],
          lane: topic.lane || 'psychology',
          discoveredAt: new Date().toISOString(),
          discoveredFrom: topic.name,
        });

        if (candidates.length >= 10) break;
      }

      if (candidates.length >= 10) break;
    } catch (e) {
      // Google News search failed for this topic, continue
    }
  }

  return candidates;
}

/**
 * Attempt to find RSS feed URL for a domain
 * Tries common RSS paths: /feed, /feed/, /rss, /rss.xml, /feeds/news, atom.xml
 */
async function findRssFeedForDomain(domain) {
  const commonPaths = ['/feed', '/feed/', '/rss', '/rss.xml', '/feeds/news', '/atom.xml', '/feed.xml'];

  for (const path of commonPaths) {
    try {
      const url = `https://${domain}${path}`;
      const response = await axios.get(url, { timeout: 5000, validateStatus: () => true });

      if (response.status === 200 && (response.data.includes('<rss') || response.data.includes('<feed'))) {
        return url;
      }
    } catch {}
  }

  // Try homepage meta tags
  try {
    const response = await axios.get(`https://${domain}`, { timeout: 5000 });
    const $ = cheerio.load(response.data);
    const feedLink = $('link[rel="alternate"][type="application/rss+xml"]').attr('href') ||
                     $('link[rel="alternate"][type="application/atom+xml"]').attr('href');
    if (feedLink) {
      return feedLink.startsWith('http') ? feedLink : `https://${domain}${feedLink}`;
    }
  } catch {}

  return null;
}

/**
 * Use Claude Haiku to evaluate if a domain is "mid-tier" (not tiny blog, not top 20 global)
 */
async function evaluateMidTierStatus(domain) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Is "${domain}" a mid-tier publication? (Not a personal blog, not a tiny niche site, but also not in top 100 global news orgs.) Reply YES or NO only.`,
        },
      ],
    });

    const answer = response.content[0].type === 'text' ? response.content[0].text.toUpperCase() : 'NO';
    return answer.includes('YES');
  } catch {
    return false;
  }
}

/**
 * Format domain into human-readable publication name
 */
function formatPublicationName(domain) {
  return domain
    .replace(/\.com$|\.net$|\.org$|\.co\.uk$/, '')
    .replace(/^www\./, '')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Evaluate active publications and promote candidates
 * Retires underperformers, promotes high-potential candidates
 * @param {Object} dynamicPublications - { active, candidates, retired }
 * @returns {Object} Updated dynamicPublications
 */
export async function evaluatePublications(dynamicPublications) {
  if (!dynamicPublications.active) dynamicPublications.active = [];
  if (!dynamicPublications.candidates) dynamicPublications.candidates = [];
  if (!dynamicPublications.retired) dynamicPublications.retired = [];

  const now = new Date();

  // Review active publications for retirement
  const toRetire = [];
  dynamicPublications.active = dynamicPublications.active.filter(pub => {
    const articlesUsed = pub.articlesUsed || 0;
    const successRate = pub.successRate || 0;
    const daysSinceUse = (now - new Date(pub.lastUsed || pub.addedAt)) / (1000 * 60 * 60 * 24);

    // Retire if underperforming (< 20% success after 10+ articles)
    if (articlesUsed >= 10 && successRate < 0.2) {
      toRetire.push({ ...pub, reason: 'Low success rate (<20% after 10+ articles)' });
      return false;
    }

    // Retire if inactive (not used in 14 days)
    if (daysSinceUse > 14) {
      toRetire.push({ ...pub, reason: 'Inactive (14+ days without use)' });
      return false;
    }

    return true;
  });

  // Archive retired publications
  dynamicPublications.retired.push(
    ...toRetire.map(pub => ({ ...pub, retiredAt: now.toISOString() }))
  );

  // Promote top candidates to active (max 5 new per cycle)
  const slotsAvailable = Math.max(0, 15 - dynamicPublications.active.length);
  const topCandidates = (dynamicPublications.candidates || [])
    .sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt))
    .slice(0, slotsAvailable);

  topCandidates.forEach(candidate => {
    dynamicPublications.active.push({
      ...candidate,
      addedAt: new Date().toISOString(),
      articlesUsed: 0,
      successRate: 0,
      lastUsed: new Date().toISOString(),
    });
  });

  // Remove promoted candidates from candidate list
  if (topCandidates.length > 0) {
    const promotedNames = new Set(topCandidates.map(c => c.name));
    dynamicPublications.candidates = (dynamicPublications.candidates || []).filter(
      c => !promotedNames.has(c.name)
    );
  }

  return dynamicPublications;
}

/**
 * Get merged publication list: static MONITORED_PUBLICATIONS + dynamic active
 * @param {Object} monitoredPublications - Static publications by lane
 * @param {Array} dynamicActive - Active dynamic publications
 * @param {String} lane - Optional filter by lane (psychology, entertainment, etc.)
 * @returns {Array} Merged publication list for the lane
 */
export function getActivePublications(monitoredPublications, dynamicActive = [], lane = null) {
  // Static publications for this lane
  const staticPubs = lane && monitoredPublications[lane] ? monitoredPublications[lane] : [];

  // Dynamic publications (filtered by lane if specified)
  const dynamicPubs = dynamicActive.filter(pub => !lane || pub.lane === lane);

  // Merge and deduplicate by domain
  const merged = [];
  const seenDomains = new Set();

  [...staticPubs, ...dynamicPubs].forEach(pub => {
    const domain = pub.domains?.[0]?.toLowerCase();
    if (domain && !seenDomains.has(domain)) {
      seenDomains.add(domain);
      merged.push(pub);
    }
  });

  return merged;
}

/**
 * Record success/failure of an article from a publication
 * Updates the publication's success rate
 * @param {Object} dynamicPublications - { active, candidates, retired }
 * @param {String} pubName - Publication name
 * @param {Boolean} success - true if article performed well
 * @returns {Object} Updated dynamicPublications
 */
export function recordPublicationUse(dynamicPublications, pubName, success) {
  const pub = dynamicPublications.active?.find(p => p.name === pubName);
  if (!pub) return dynamicPublications;

  // Simple exponential moving average for success rate
  const currentRate = pub.successRate || 0;
  const articlesUsed = (pub.articlesUsed || 0) + 1;
  const newRate = (currentRate * (articlesUsed - 1) + (success ? 1 : 0)) / articlesUsed;

  pub.articlesUsed = articlesUsed;
  pub.successRate = Math.round(newRate * 1000) / 1000;
  pub.lastUsed = new Date().toISOString();

  return dynamicPublications;
}
