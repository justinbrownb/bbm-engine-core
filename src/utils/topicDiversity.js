// Topic diversity enforcement — prevents any single topic cluster from dominating daily output
// Tracks topic clusters published today and blocks over-representation.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

/**
 * Assign a topic cluster to a title using Claude Haiku.
 * Returns a short cluster key like "aging-brain", "retirement-finance", "kpop-comeback", etc.
 *
 * @param {string} title - The article title
 * @returns {string} Topic cluster key (2-3 words, hyphenated, lowercase)
 */
export async function assignTopicCluster(title) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: `You are a topic classifier. Given an article title, return a short topic cluster key (2-3 lowercase words, hyphenated) that captures the core topic area. Examples: "aging-brain", "retirement-identity", "kpop-comeback", "ai-ethics", "financial-psychology", "relationship-patterns", "loneliness-society", "workplace-burnout", "generational-dynamics". Be specific enough to distinguish topics but broad enough to group similar articles. Return ONLY the cluster key, nothing else.`,
      messages: [{ role: 'user', content: title }],
    });
    const cluster = (resp.content[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    return cluster || 'general';
  } catch (e) {
    console.warn(`[TopicDiversity] Cluster assignment failed for "${title}": ${e.message}`);
    // Fallback: extract first meaningful words from title
    const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    return words.slice(0, 2).join('-') || 'general';
  }
}

/**
 * Check if publishing an article with the given topic cluster would exceed diversity limits.
 *
 * @param {string} cluster - The topic cluster key
 * @param {Object} publishedClusters - Map of { clusterKey: count } for today
 * @param {number} targetToday - Today's total article target
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkDiversityLimit(cluster, publishedClusters = {}, targetToday = 10) {
  // Max 30% of daily target for any single cluster (minimum 2)
  const maxPerCluster = Math.max(2, Math.ceil(targetToday * 0.3));
  const currentCount = publishedClusters[cluster] || 0;

  if (currentCount >= maxPerCluster) {
    return {
      allowed: false,
      reason: `Topic cluster "${cluster}" has ${currentCount}/${maxPerCluster} articles today (30% cap of ${targetToday} target)`,
    };
  }

  return { allowed: true, reason: 'Within diversity limits' };
}

/**
 * Get a summary of today's topic distribution for prompt injection.
 * Helps Claude know what's already been covered.
 *
 * @param {Object} publishedClusters - Map of { clusterKey: count }
 * @returns {string} Human-readable summary
 */
export function getTopicDistributionSummary(publishedClusters = {}) {
  const entries = Object.entries(publishedClusters).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'No articles published yet today.';

  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const lines = entries.map(([cluster, count]) => {
    const pct = Math.round((count / total) * 100);
    return `  - ${cluster}: ${count} articles (${pct}%)`;
  });

  return `TODAY'S TOPIC DISTRIBUTION (${total} articles across ${entries.length} clusters):\n${lines.join('\n')}\n\nPrioritize UNDERREPRESENTED areas. Avoid clusters that are already over 20% of output.`;
}
