// explorationTracker.js — Strategic exploration tracking
// Tags articles as exploration vs exploitation, tracks hit rates, adjusts budget dynamically

/**
 * Classifies an article as exploration or exploitation based on topic, format, and intent
 * @param {Object} titleData - { topic, format, isExperimental }
 * @param {Object} performanceLearnings - { topicClusters, formatUsage, lanes }
 * @param {Object} laneStats - { laneName: { avgVisitors, articleCount } }
 * @returns {{ isExploration: boolean, reason: string }}
 */
export function classifyArticle(titleData, performanceLearnings, laneStats) {
  const { topic, format, isExperimental } = titleData;

  // Explicit experimental tag from prompt
  if (isExperimental) {
    return { isExploration: true, reason: 'explicitly_experimental' };
  }

  // Check if topic is in top-performing clusters
  const topClusters = performanceLearnings?.topicClusters?.slice(0, 5) || [];
  const topicNames = topClusters.map(c => c.topic.toLowerCase());
  if (!topicNames.includes(topic?.toLowerCase())) {
    return { isExploration: true, reason: 'new_topic_cluster' };
  }

  // Check if format is underused (<5 articles published in that format)
  const formatCount = performanceLearnings?.formatUsage?.[format] || 0;
  if (formatCount < 5) {
    return { isExploration: true, reason: 'underused_format' };
  }

  // No red flags — this is exploitation (proven pattern)
  return { isExploration: false, reason: 'proven_pattern' };
}

/**
 * Determines whether the next article should prioritize exploration
 * @param {number} publishedToday - articles published so far today
 * @param {number} targetToday - target for today
 * @param {Object} explorationTracker - tracker state
 * @returns {boolean}
 */
export function shouldExplore(publishedToday, targetToday, explorationTracker) {
  const { explorationBudget } = explorationTracker;

  // How many exploration articles should we have published by now?
  const explorationTargetToday = Math.floor(targetToday * explorationBudget);

  // Count exploration articles published today
  const explorationToday = explorationTracker.articles
    .filter(a => {
      const pubDate = new Date(a.publishedAt);
      const today = new Date();
      return pubDate.toDateString() === today.toDateString() && a.isExploration;
    })
    .length;

  // If we haven't hit the exploration target yet, explore
  return explorationToday < explorationTargetToday;
}

/**
 * Records article performance and updates tracker stats
 * @param {string} slug - article slug
 * @param {number} visitors - traffic to article
 * @param {{ isExploration: boolean, reason: string }} classification - article classification
 * @param {Object} explorationTracker - tracker state to mutate
 */
export function recordExplorationResult(slug, visitors, classification, explorationTracker) {
  // Add article to history
  explorationTracker.articles.push({
    slug,
    isExploration: classification.isExploration,
    reason: classification.reason,
    publishedAt: new Date().toISOString(),
    visitors,
    classification
  });

  // Keep only last 500 articles to avoid unbounded growth
  if (explorationTracker.articles.length > 500) {
    explorationTracker.articles.shift();
  }

  // Recalculate stats
  const exploration = explorationTracker.articles.filter(a => a.isExploration);
  const exploitation = explorationTracker.articles.filter(a => !a.isExploration);

  const explorationStrongCount = exploration.filter(a => a.visitors > 10000).length;
  const exploitationStrongCount = exploitation.filter(a => a.visitors > 10000).length;

  explorationTracker.stats = {
    explorationHitRate: exploration.length > 0 ? explorationStrongCount / exploration.length : 0,
    exploitationHitRate: exploitation.length > 0 ? exploitationStrongCount / exploitation.length : 0,
    explorationAvgVisitors: exploration.length > 0
      ? exploration.reduce((sum, a) => sum + a.visitors, 0) / exploration.length
      : 0,
    exploitationAvgVisitors: exploitation.length > 0
      ? exploitation.reduce((sum, a) => sum + a.visitors, 0) / exploitation.length
      : 0,
    totalExploration: exploration.length,
    totalExploitation: exploitation.length
  };
}

/**
 * Dynamically adjusts exploration budget based on performance
 * @param {Object} explorationTracker - tracker state to mutate
 */
export function adjustExplorationBudget(explorationTracker) {
  const { explorationHitRate, exploitationHitRate } = explorationTracker.stats;

  // Need at least 10 articles of each type to adjust meaningfully
  if (explorationTracker.stats.totalExploration < 10 || explorationTracker.stats.totalExploitation < 10) {
    return; // Not enough data
  }

  const currentBudget = explorationTracker.explorationBudget;
  let newBudget = currentBudget;

  // If exploration outperforms, increase budget (up to 25%)
  if (explorationHitRate > exploitationHitRate) {
    newBudget = Math.min(currentBudget + 0.02, 0.25);
  }
  // If exploration severely underperforms (<50% of exploitation), decrease (down to 10%)
  else if (explorationHitRate < exploitationHitRate * 0.5) {
    newBudget = Math.max(currentBudget - 0.02, 0.10);
  }
  // Otherwise hold steady

  explorationTracker.explorationBudget = newBudget;
  explorationTracker.lastBudgetUpdate = new Date().toISOString();
}

/**
 * Generates human-readable summary for title generation prompt
 * @param {Object} explorationTracker - tracker state
 * @returns {string}
 */
export function getExplorationSummary(explorationTracker) {
  const { stats, explorationBudget, articles } = explorationTracker;

  // Find recent exploration wins
  const recentExploration = articles
    .filter(a => a.isExploration && a.visitors > 15000)
    .slice(-3)
    .map(a => `"${a.slug.split('-').slice(2).join(' ')}"`)
    .join(', ');

  const hitRateDiff = ((stats.explorationHitRate - stats.exploitationHitRate) * 100).toFixed(1);
  const hitRateComp = stats.explorationHitRate > stats.exploitationHitRate ? 'outperforming' : 'underperforming';

  let summary = `Exploration budget: ${(explorationBudget * 100).toFixed(0)}% `;
  summary += `(exploration hit rate ${(stats.explorationHitRate * 100).toFixed(0)}% vs exploitation ${(stats.exploitationHitRate * 100).toFixed(0)}%, ${hitRateComp} by ${Math.abs(hitRateDiff)}%).`;

  if (recentExploration) {
    summary += ` Recent exploration wins: ${recentExploration}.`;
  }

  summary += ` ${stats.explorationHitRate > 0.2 ? 'Exploration is strong — try bold new angles.' : 'Focus on proven patterns for now.'}`;

  return summary;
}

export default {
  classifyArticle,
  shouldExplore,
  recordExplorationResult,
  adjustExplorationBudget,
  getExplorationSummary
};
