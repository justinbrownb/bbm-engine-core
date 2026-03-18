// @bbm/engine-core — shared utilities for BBM content engines and bots
//
// Preferred import pattern (tree-shakeable, explicit):
//   import { factCheckArticle } from '@bbm/engine-core/utils/factCheck.js';
//   import { generateSlug } from '@bbm/engine-core/utils/slugify.js';
//   import { MODELS } from '@bbm/engine-core/constants';
//
// Barrel import (convenience, imports everything):
//   import { factCheckArticle, generateSlug, MODELS } from '@bbm/engine-core';

// Constants
export * from './constants.js';

// --- Utilities ---

// Article quality & rewriting
export { rewriteForBioConsistency } from './utils/articleRewriter.js';
export { validateBiography } from './utils/bioValidator.js';
export { validateCitations } from './utils/citationValidator.js';
export { factCheckArticle } from './utils/factCheck.js';
export { checkAndStripDeadLinks, extractExternalUrls, checkArticleLinks, formatLinkCheckForReviewer } from './utils/linkChecker.js';
export { verifyAndFixLinks } from './utils/linkVerifier.js';
export { scoreArticleQuality, buildRewriteGuidance, MIN_QUALITY_SCORE, DRAFT_THRESHOLD } from './utils/qualityCeiling.js';
export { verifyTitleClaims } from './utils/verifyTitleClaims.js';
export { filterTitlesByBio } from './utils/titleBioGuard.js';

// Deduplication & diversity
export { deduplicateArticles, deduplicateTrends, generateStoryKey, extractStorySignatures, filterNewStories } from './utils/storyDedup.js';
export { assignTopicCluster, checkDiversityLimit, getTopicDistributionSummary } from './utils/topicDiversity.js';

// Performance & exploration
export { classifyArticle, shouldExplore, recordExplorationResult, adjustExplorationBudget, getExplorationSummary } from './utils/explorationTracker.js';
export { computeBenchmark, getVolumeAdjustment, getBenchmarkPromptBlock, getAdjustedExplorationRate, getBenchmarkDigestBlock } from './utils/performanceTargets.js';
export { getNetworkInsights, getSiteTopPerformers, getSiteSourceBreakdown } from './utils/networkIntelligence.js';
export { fetchDiscoverLearnings } from './utils/discoverLearnings.js';

// Source research
export { researchSources, formatSourcesForPrompt, researchSourcesFromBrief, formatEnhancedSourcesForPrompt } from './utils/sourceResearch.js';
export { researchWebSources, formatWebSourcesForPrompt } from './utils/webSourceResearch.js';

// Publication monitoring
export { scanPublications, triageArticles, fetchAndSummarize, buildResearchBrief, searchTopicInPublications } from './utils/publicationMonitor.js';
export { discoverNewPublications, evaluatePublications, getActivePublications, recordPublicationUse } from './utils/publicationDiscovery.js';

// Pitch matching
export { matchPitchToArticle, shouldAttemptPitch, trackPitchInsertion, updatePitchArticleUrl, buildPitchDailyDigest } from './utils/pitchMatcher.js';

// Newsletter
export { scoreForNewsletter } from './utils/newsletterScorer.js';

// Slugs & scheduling
export { generateSlug, toSlug, getPrefixForTier } from './utils/slugify.js';
export { getNextPublishTime, recordPublish, initScheduler, getPublishParams } from './utils/publishScheduler.js';

// Content helpers
export { selectRelevantDetails } from './utils/detailSelector.js';
export { generateImageQuery, generateInlineImageQuery } from './utils/imageQuery.js';

// Health & monitoring
export { startHealthServer, log, getRecentEvents, getHealthSummary, setStateProvider } from './utils/health.js';
