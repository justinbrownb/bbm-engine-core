// Performance Targets — shared across all content engines
// Computes dynamic benchmarks from network intelligence data.
// Engines compete to beat team average by 20%.
//
// Usage:
//   import { computeBenchmark, getVolumeAdjustment, getBenchmarkPromptBlock } from './performanceTargets.js';
//   const benchmark = computeBenchmark(networkInsights.data);
//   const volumeAdj = getVolumeAdjustment(benchmark);
//   const promptBlock = getBenchmarkPromptBlock(benchmark);

/**
 * Compute the engine's benchmark position relative to team average.
 *
 * @param {object} networkData - The `.data` object from getNetworkInsights()
 * @param {object} options
 * @param {number} options.beatTarget - Multiplier vs team avg to aim for (default 1.2 = beat by 20%)
 * @param {number} options.fallbackStrong - Fallback strong threshold if no team data (default 200)
 * @param {number} options.fallbackAverage - Fallback average threshold if no team data (default 50)
 * @returns {object} benchmark
 */
export function computeBenchmark(networkData, options = {}) {
  const beatTarget = options.beatTarget || 1.2;
  const fallbackStrong = options.fallbackStrong || 200;
  const fallbackAverage = options.fallbackAverage || 50;

  const result = {
    hasData: false,
    engineAvg: 0,
    engineArticles: 0,
    teamAvg: 0,
    teamMembers: 0,
    targetAvg: 0,           // team avg × beatTarget
    gap: 0,                 // engineAvg - targetAvg (negative = below target)
    gapPct: 0,              // gap as % of target
    position: 'unknown',    // 'crushing' | 'above' | 'close' | 'below' | 'struggling'
    dynamicStrong: fallbackStrong,
    dynamicAverage: fallbackAverage,
    volumeSignal: 'hold',   // 'increase' | 'hold' | 'reduce'
    topTeamMember: null,     // { label, avgVisitors }
    networkTopTopics: [],    // Top 5 network-wide winning topics
  };

  if (!networkData?.enginePerf || !networkData?.teamPerf) {
    return result;
  }

  const { enginePerf, teamPerf, rankedTopics, crossSiteTopPerformers } = networkData;

  // Calculate team average (excluding zero-article members)
  const teamEntries = Object.values(teamPerf).filter(t => t.articles > 0);
  if (teamEntries.length === 0) return result;

  const teamAvg = Math.round(
    teamEntries.reduce((sum, t) => sum + t.avgVisitors, 0) / teamEntries.length
  );

  // Find top team member
  const topTeam = teamEntries.reduce((best, t) =>
    t.avgVisitors > (best?.avgVisitors || 0) ? t : best, null);

  result.hasData = true;
  result.engineAvg = enginePerf.avgVisitors || 0;
  result.engineArticles = enginePerf.articles || 0;
  result.teamAvg = teamAvg;
  result.teamMembers = teamEntries.length;
  result.targetAvg = Math.round(teamAvg * beatTarget);
  result.gap = result.engineAvg - result.targetAvg;
  result.gapPct = result.targetAvg > 0
    ? Math.round((result.gap / result.targetAvg) * 100)
    : 0;

  if (topTeam) {
    result.topTeamMember = { label: topTeam.label, avgVisitors: topTeam.avgVisitors };
  }

  // Classify position
  if (result.engineAvg >= result.targetAvg * 1.3) {
    result.position = 'crushing';    // 30%+ above target (56%+ above team avg)
  } else if (result.engineAvg >= result.targetAvg) {
    result.position = 'above';       // At or above target
  } else if (result.engineAvg >= teamAvg * 0.9) {
    result.position = 'close';       // Within 10% of team avg (but below 120% target)
  } else if (result.engineAvg >= teamAvg * 0.6) {
    result.position = 'below';       // 10-40% below team avg
  } else {
    result.position = 'struggling';  // >40% below team avg
  }

  // Dynamic thresholds based on team performance
  // "Strong" = beating the target (team avg × 1.2)
  // "Average" = at or near team average
  // "Weak" = significantly below team average
  result.dynamicStrong = Math.max(fallbackStrong, result.targetAvg);
  result.dynamicAverage = Math.max(fallbackAverage, Math.round(teamAvg * 0.7));

  // Volume signal
  if (result.position === 'struggling' || result.position === 'below') {
    result.volumeSignal = 'reduce';  // Publish less, focus on quality
  } else if (result.position === 'crushing') {
    result.volumeSignal = 'increase'; // Earning the right to publish more
  } else {
    result.volumeSignal = 'hold';
  }

  // Top network topics for prompt context
  if (rankedTopics?.length > 0) {
    result.networkTopTopics = rankedTopics.slice(0, 5).map(t => ({
      keyword: t.keyword,
      visitors: t.totalVisitors,
      sites: t.siteCount,
    }));
  }

  return result;
}

/**
 * Get a volume adjustment multiplier based on benchmark position.
 * Apply to adaptive target calculations.
 *
 * @param {object} benchmark - Output from computeBenchmark()
 * @returns {number} multiplier (0.7-1.2)
 */
export function getVolumeAdjustment(benchmark) {
  if (!benchmark.hasData) return 1.0;

  switch (benchmark.volumeSignal) {
    case 'reduce':
      // Below team: publish 70-85% of normal to focus on quality
      return benchmark.position === 'struggling' ? 0.7 : 0.85;
    case 'increase':
      // Crushing it: publish 10-20% more
      return 1.15;
    default:
      return 1.0;
  }
}

/**
 * Generate a prompt block for title generation that includes benchmark context.
 * This makes Claude aware of the competitive position and adjusts strategy accordingly.
 *
 * @param {object} benchmark - Output from computeBenchmark()
 * @returns {string} Text block to inject into title generation prompts
 */
export function getBenchmarkPromptBlock(benchmark) {
  if (!benchmark.hasData) return '';

  let block = '\n=== PERFORMANCE BENCHMARK ===\n';
  block += `Your engine avg: ${benchmark.engineAvg} visitors/article\n`;
  block += `Team avg across this site: ${benchmark.teamAvg} visitors/article\n`;
  block += `Target: ${benchmark.targetAvg} visitors/article (beat team by 20%)\n`;

  if (benchmark.topTeamMember) {
    block += `Top team member: ${benchmark.topTeamMember.label} at ${benchmark.topTeamMember.avgVisitors} visitors/article\n`;
  }

  if (benchmark.gap >= 0) {
    block += `Status: ${benchmark.gapPct}% ABOVE target. You're outperforming. Keep pushing boundaries.\n`;
  } else {
    block += `Status: ${Math.abs(benchmark.gapPct)}% BELOW target. Close the gap. Prioritize proven high-traffic patterns.\n`;
  }

  // Strategic guidance based on position
  switch (benchmark.position) {
    case 'crushing':
      block += `Strategy: You've earned room to experiment. Use 25% exploration budget. Try bold angles that could break out.\n`;
      break;
    case 'above':
      block += `Strategy: Solid position. Maintain what works, 15% exploration budget. Refine winning formulas.\n`;
      break;
    case 'close':
      block += `Strategy: Almost there. Lean into your top 3 performing topic patterns. 10% exploration max.\n`;
      break;
    case 'below':
      block += `Strategy: Quality over volume. Study what the top team member does differently. Stick to proven patterns. 5% exploration.\n`;
      break;
    case 'struggling':
      block += `Strategy: Reset mode. ONLY use proven high-traffic patterns from network data. Zero exploration until avg improves.\n`;
      break;
  }

  // Network context for topic selection
  if (benchmark.networkTopTopics.length > 0) {
    block += `\nTop network-wide topics right now:\n`;
    for (const t of benchmark.networkTopTopics) {
      block += `  - "${t.keyword}" (${t.visitors} visitors, ${t.sites} sites)\n`;
    }
  }

  block += '=== END BENCHMARK ===\n';
  return block;
}

/**
 * Get adjusted exploration rate based on benchmark position.
 * Overrides the static exploration rate in config.
 *
 * @param {object} benchmark - Output from computeBenchmark()
 * @param {number} baseRate - Engine's default exploration rate (e.g., 0.15)
 * @returns {number} Adjusted exploration rate
 */
export function getAdjustedExplorationRate(benchmark, baseRate = 0.15) {
  if (!benchmark.hasData) return baseRate;

  switch (benchmark.position) {
    case 'crushing': return Math.min(0.25, baseRate * 1.7);
    case 'above': return baseRate;
    case 'close': return Math.max(0.10, baseRate * 0.67);
    case 'below': return 0.05;
    case 'struggling': return 0;
    default: return baseRate;
  }
}

/**
 * Build a Telegram-friendly summary of benchmark status for daily digest.
 *
 * @param {object} benchmark - Output from computeBenchmark()
 * @returns {string} Telegram-formatted benchmark summary
 */
export function getBenchmarkDigestBlock(benchmark) {
  if (!benchmark.hasData) return '';

  const emoji = {
    crushing: '🔥',
    above: '✅',
    close: '🎯',
    below: '⚠️',
    struggling: '🚨',
  };

  let s = `\n${emoji[benchmark.position] || '📊'} BENCHMARK: `;
  s += `Engine ${benchmark.engineAvg} vs Team ${benchmark.teamAvg} (target ${benchmark.targetAvg})\n`;

  if (benchmark.gap >= 0) {
    s += `  ${benchmark.gapPct}% above target`;
  } else {
    s += `  ${Math.abs(benchmark.gapPct)}% below target`;
  }

  s += ` | Volume: ${benchmark.volumeSignal}`;

  if (benchmark.topTeamMember) {
    s += ` | Top: ${benchmark.topTeamMember.label} (${benchmark.topTeamMember.avgVisitors})`;
  }

  return s;
}
