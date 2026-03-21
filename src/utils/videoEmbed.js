/**
 * Shared YouTube video embed utilities for WordPress articles.
 *
 * WordPress auto-embeds bare YouTube URLs via oEmbed when they sit on their own line.
 * The Gutenberg wp:embed block format does NOT render on Classic Editor sites,
 * so we always use bare URLs.
 *
 * Usage:
 *   import { buildVideoEmbedBlock, insertEmbedIntoArticle } from '@bbm/engine-core/src/utils/videoEmbed.js';
 *
 *   const embedBlock = buildVideoEmbedBlock(referenceText, videoUrl);
 *   const updatedContent = insertEmbedIntoArticle(articleContent, embedBlock, { position: 0.75 });
 */

/**
 * Build an embed block: reference paragraph + bare YouTube URL on its own line.
 *
 * @param {string} referenceText - The 1-2 sentence intro text (plain text or HTML)
 * @param {string} videoUrl - Full YouTube video URL
 * @returns {string} HTML block ready to insert into article content
 */
export function buildVideoEmbedBlock(referenceText, videoUrl) {
  return `<p>${referenceText}</p>\n${videoUrl}`;
}

/**
 * Insert an embed block into article HTML content at a target position.
 *
 * @param {string} articleContent - Full article HTML
 * @param {string} embedBlock - From buildVideoEmbedBlock()
 * @param {object} options
 * @param {number} [options.position=0.75] - Target position as fraction of article (0.0-1.0)
 * @param {number} [options.minParagraph=6] - Minimum paragraph index before inserting
 * @returns {string} Modified article HTML with embed inserted
 */
export function insertEmbedIntoArticle(articleContent, embedBlock, options = {}) {
  const { position = 0.75, minParagraph = 6 } = options;

  const pCloseRegex = /<\/p>/g;
  const pPositions = [];
  let pMatch;
  while ((pMatch = pCloseRegex.exec(articleContent)) !== null) {
    pPositions.push(pMatch.index + 4); // position after </p>
  }

  const totalParagraphs = pPositions.length;

  if (totalParagraphs >= minParagraph) {
    const targetParagraph = Math.max(minParagraph, Math.floor(totalParagraphs * position));
    const insertIndex = Math.min(targetParagraph, totalParagraphs - 1);
    const insertPoint = pPositions[insertIndex - 1];
    const before = articleContent.substring(0, insertPoint);
    const after = articleContent.substring(insertPoint);
    return `${before}\n${embedBlock}\n${after}`;
  } else if (totalParagraphs >= 4) {
    const insertPoint = pPositions[totalParagraphs - 2];
    const before = articleContent.substring(0, insertPoint);
    const after = articleContent.substring(insertPoint);
    return `${before}\n${embedBlock}\n${after}`;
  }

  // Very short article or fallback: append at end
  return `${articleContent}\n${embedBlock}`;
}
