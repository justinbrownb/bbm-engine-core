/**
 * Pitch matching and insertion for articles.
 *
 * Inserts contextual promotional callouts (e.g., quizzes, resources) into articles
 * where reader intent aligns. Modeled after Substack's mid-article callout style:
 * two horizontal rules, italic text, same font as article, link inherits site color.
 *
 * Design principles:
 * - Never in news articles
 * - Never stacked with a YouTube video embed in the same article
 * - ~15-20% random pre-gate → Claude evaluates intent → ~10% of articles get a pitch
 * - Placement: 60-75% through the article
 * - Pre-written templates (not AI-generated each time)
 * - Registry pattern: supports multiple pitches over time
 */

import { callClaude } from '../services/writer.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../..');
const PITCH_LOG_FILE = path.join(DATA_DIR, '.pitch-log.json');

// ==================== PITCH REGISTRY ====================
// Each pitch has: id, name, url, internal/external templates, active flag
// "internal" = thevessel.io (we/our voice, no label)
// "external" = all other sites (Partner content label, third-person voice)

const PITCH_REGISTRY = [
  {
    id: 'wild-soul-archetype-quiz',
    name: 'Wild Soul Archetype Quiz',
    url: 'https://thevessel.io/wild-soul-archetype-quiz/',
    active: true,
    // Topics/themes where this pitch has high intent alignment
    intentKeywords: [
      'self-discovery', 'identity', 'personality', 'archetype', 'soul',
      'who you really are', 'inner self', 'healing', 'emotional patterns',
      'relationships', 'love', 'fight', 'conflict', 'psychology',
      'self-awareness', 'authenticity', 'letting go', 'inner work',
      'childhood', 'attachment', 'emotional intelligence', 'loneliness',
      'introversion', 'sensitivity', 'empathy', 'boundaries',
      'aging', 'wisdom', 'growth', 'transformation', 'resilience',
    ],
    // Templates for thevessel.io (internal — "we" voice, no label)
    internalTemplates: [
      'We created a free quiz to help you discover your wild soul archetype. It takes 2 minutes.',
      'Curious about your wild soul archetype? We put together a quick quiz to help you find out.',
      "There's a side of you that drives everything — your wild soul archetype. We built a short quiz to help you uncover it.",
    ],
    // Templates for all other sites (external — "Partner content" label, third-person)
    externalTemplates: [
      "The Vessel have created a free quiz that reveals your wild soul archetype — the part of you that drives everything. Takes 2 minutes.",
      'Curious which wild soul archetype you are? The Vessel put together a quick quiz to help you find out.',
      "There's a part of you that drives how you love, fight, and heal — your wild soul archetype. The Vessel built a short quiz to uncover it.",
    ],
  },
];

// ==================== PITCH LOG (daily tracking) ====================

let pitchLog = [];

function loadPitchLog() {
  try {
    pitchLog = JSON.parse(fs.readFileSync(PITCH_LOG_FILE, 'utf8'));
    // Trim to last 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    pitchLog = pitchLog.filter(e => new Date(e.timestamp).getTime() > cutoff);
  } catch {
    pitchLog = [];
  }
}

function savePitchLog() {
  try {
    fs.writeFileSync(PITCH_LOG_FILE, JSON.stringify(pitchLog, null, 2));
  } catch (e) {
    console.error(`Failed to save pitch log: ${e.message}`);
  }
}

/**
 * Record a pitch insertion for daily reporting.
 */
export function trackPitchInsertion({ pitchId, pitchName, articleTitle, domain, articleUrl }) {
  loadPitchLog();
  pitchLog.push({
    pitchId,
    pitchName,
    articleTitle,
    domain,
    articleUrl: articleUrl || '',
    timestamp: new Date().toISOString(),
  });
  savePitchLog();
}

/**
 * Update pitch log entry with the published article URL (called after publish).
 */
export function updatePitchArticleUrl(articleTitle, domain, url) {
  loadPitchLog();
  const entry = pitchLog.find(e =>
    e.articleTitle === articleTitle && e.domain === domain && !e.articleUrl
  );
  if (entry) {
    entry.articleUrl = url;
    savePitchLog();
  }
}

/**
 * Build a daily pitch digest for Telegram reporting.
 */
export function buildPitchDailyDigest() {
  loadPitchLog();
  const today = new Date().toISOString().split('T')[0];
  const todayEntries = pitchLog.filter(e => e.timestamp.startsWith(today));

  if (todayEntries.length === 0) {
    return '<b>📢 Pitch Report</b>\n\nNo pitches inserted today.';
  }

  let msg = `<b>📢 Pitch Report — ${todayEntries.length} pitch${todayEntries.length > 1 ? 'es' : ''} today</b>\n\n`;

  // Group by pitch
  const byPitch = {};
  for (const e of todayEntries) {
    if (!byPitch[e.pitchName]) byPitch[e.pitchName] = [];
    byPitch[e.pitchName].push(e);
  }

  for (const [pitchName, entries] of Object.entries(byPitch)) {
    msg += `<b>${pitchName}</b> (${entries.length}):\n`;
    for (const e of entries) {
      const title = e.articleTitle.length > 60 ? e.articleTitle.substring(0, 60) + '...' : e.articleTitle;
      msg += `• ${title}\n  ${e.domain}${e.articleUrl ? ` — ${e.articleUrl}` : ''}\n`;
    }
    msg += '\n';
  }

  return msg;
}

// ==================== RANDOM PRE-GATE ====================

/**
 * Random pre-gate — returns true ~20% of the time (or 100% if forced).
 * Used to limit pitch attempts before spending tokens on intent matching.
 */
export function shouldAttemptPitch(forcePitch = false) {
  if (forcePitch) return true;
  return Math.random() < 0.20;
}

// ==================== INTENT MATCHING ====================

/**
 * Check if the article has reader intent that aligns with any active pitch.
 * Uses Claude to evaluate whether a pitch would feel natural and welcome.
 *
 * @param {string} articleTitle
 * @param {string} articleContent - HTML content
 * @param {string} articleExcerpt
 * @param {object} options
 * @param {string} options.domain - the publishing domain
 * @param {boolean} options.hasVideoEmbed - whether article already has a video embed
 * @param {boolean} options.forcePitch - force a pitch to be included
 * @returns {object|null} { pitchId, pitchName, url, template, isInternal } or null
 */
export async function matchPitchToArticle(articleTitle, articleContent, articleExcerpt, options = {}) {
  const { domain, hasVideoEmbed = false, forcePitch = false } = options;

  // Never stack with a video embed (unless forced)
  if (hasVideoEmbed && !forcePitch) {
    console.log('[PitchMatcher] Skipping — article already has a video embed');
    return null;
  }

  // Get active pitches
  const activePitches = PITCH_REGISTRY.filter(p => p.active);
  if (activePitches.length === 0) {
    console.log('[PitchMatcher] No active pitches in registry');
    return null;
  }

  // Determine if this is an internal (thevessel.io) or external site
  const isInternal = domain === 'thevessel.io';

  // Strip HTML for cleaner matching
  const plainArticle = articleContent
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .substring(0, 3000);

  // Build pitch descriptions for Claude
  const pitchDescriptions = activePitches.map((p, i) => {
    return `[${i}] "${p.name}" — ${p.url}\nTopics: ${p.intentKeywords.slice(0, 15).join(', ')}`;
  }).join('\n\n');

  const matchPrompt = `You are an editorial quality controller deciding whether to include a promotional callout in an article. The callout must feel natural and genuinely relevant — not forced.

ARTICLE TITLE: "${articleTitle}"
ARTICLE EXCERPT: "${articleExcerpt}"
ARTICLE CONTENT (first 3000 chars):
${plainArticle}

AVAILABLE PITCHES:
${pitchDescriptions}

MATCHING GUIDELINES:
- The article's topic should naturally lead a reader to be curious about the pitch
- A good match: article about identity struggles + quiz about discovering your archetype — the reader is already in self-reflection mode
- A good match: article about relationship patterns + quiz about what drives how you love and fight — reader would genuinely be curious
- A bad match: article about retirement finances + soul archetype quiz — no natural intent connection
- A bad match: article about cooking tips + soul archetype quiz — completely unrelated
- The reader should be in a mindset where the pitch feels like a natural next step, not an interruption
${forcePitch ? '- NOTE: This is a FORCE PITCH — you MUST find a match if there is ANY reasonable connection. Lower the bar significantly.' : '- Be selective — only say yes when the intent alignment is genuine'}

If you find a relevant match, respond with JSON:
{"match":true,"pitchIndex":0,"reason":"One sentence explaining why the reader would be receptive"}

If no good match exists, respond with:
{"match":false}

Respond ONLY with JSON, no markdown, no explanation.`;

  try {
    const response = await callClaude(
      'You are an editorial quality controller. Only recommend promotional callouts when reader intent genuinely aligns.',
      matchPrompt,
      { maxTokens: 300, model: 'claude-sonnet-4-5-20250929' }
    );

    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    const matchObj = jsonStr.match(/\{[\s\S]*\}/);
    const result = JSON.parse(matchObj ? matchObj[0] : jsonStr);

    if (!result.match) {
      console.log('[PitchMatcher] No intent match found');
      return null;
    }

    const pitchIdx = result.pitchIndex;
    if (pitchIdx < 0 || pitchIdx >= activePitches.length) {
      console.log(`[PitchMatcher] Invalid pitch index ${pitchIdx}`);
      return null;
    }

    const pitch = activePitches[pitchIdx];
    const templates = isInternal ? pitch.internalTemplates : pitch.externalTemplates;
    const template = templates[Math.floor(Math.random() * templates.length)];

    console.log(`[PitchMatcher] Matched "${pitch.name}" — ${result.reason}`);

    return {
      pitchId: pitch.id,
      pitchName: pitch.name,
      url: pitch.url,
      template,
      isInternal,
      matchReason: result.reason,
    };
  } catch (e) {
    console.error(`[PitchMatcher] Matching failed: ${e.message}`);
    return null;
  }
}

// ==================== HTML INSERTION ====================

/**
 * Build the pitch callout HTML block.
 *
 * Internal (thevessel.io): no label, "we" voice
 * External (all other sites): "Partner content" label, third-person voice
 *
 * @param {object} pitchMatch - from matchPitchToArticle
 * @returns {string} HTML block
 */
function buildPitchHtml(pitchMatch) {
  const { template, url, isInternal } = pitchMatch;

  if (isInternal) {
    // thevessel.io — no label, just the callout
    return [
      '<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 24px;" />',
      `<p><em>${template}</em></p>`,
      `<p><em><a href="${url}" target="_blank" rel="noopener">Take the free quiz</a></em></p>`,
      '<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 32px;" />',
    ].join('\n');
  }

  // External — "Partner content" label
  return [
    '<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 24px;" />',
    '<p style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#999;margin:0 0 8px;">Partner content</p>',
    `<p><em>${template}</em></p>`,
    `<p><em><a href="${url}" target="_blank" rel="noopener">Take the free quiz</a></em></p>`,
    '<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 32px;" />',
  ].join('\n');
}

/**
 * Insert a pitch callout into the article at 60-75% through.
 *
 * @param {string} articleContent - HTML content
 * @param {object} pitchMatch - from matchPitchToArticle
 * @returns {string} Modified article HTML with pitch inserted
 */
export function insertPitch(articleContent, pitchMatch) {
  const pitchHtml = buildPitchHtml(pitchMatch);

  // Find all closing </p> tags to determine paragraph positions
  const closingTags = [];
  const regex = /<\/p>/gi;
  let match;
  while ((match = regex.exec(articleContent)) !== null) {
    closingTags.push(match.index + match[0].length);
  }

  if (closingTags.length < 4) {
    // Article too short — append before last paragraph
    const lastP = articleContent.lastIndexOf('<p');
    if (lastP > 0) {
      return articleContent.substring(0, lastP) + '\n' + pitchHtml + '\n' + articleContent.substring(lastP);
    }
    return articleContent + '\n' + pitchHtml;
  }

  // Target 60-75% through the article (by paragraph count)
  const targetMin = Math.floor(closingTags.length * 0.60);
  const targetMax = Math.floor(closingTags.length * 0.75);
  // Pick a random position in the range
  const targetIdx = targetMin + Math.floor(Math.random() * (targetMax - targetMin + 1));
  const insertPos = closingTags[Math.min(targetIdx, closingTags.length - 2)];

  const before = articleContent.substring(0, insertPos);
  const after = articleContent.substring(insertPos);

  return `${before}\n${pitchHtml}\n${after}`;
}

/**
 * Get all active pitch names (for reporting).
 */
export function getActivePitchNames() {
  return PITCH_REGISTRY.filter(p => p.active).map(p => p.name);
}
