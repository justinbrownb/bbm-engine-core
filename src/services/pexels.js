import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateImageQuery } from '../utils/imageQuery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Retry helper for transient API errors (503, 429, network) ───
async function withRetry(fn, { maxRetries = 3, baseDelay = 1500, label = 'API call' } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e.response?.status;
      const isRetryable = status === 503 || status === 429 || status === 502 || status === 500 || !e.response;
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = status === 429
        ? baseDelay * Math.pow(3, attempt)
        : baseDelay * Math.pow(2, attempt);
      console.log(`[Pexels] ${label} failed (${status || e.code || 'network'}), retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

const pexelsClient = axios.create({
  baseURL: 'https://api.pexels.com/v1',
  headers: {
    Authorization: process.env.PEXELS_API_KEY,
  },
  timeout: 15000,
});

// ─── Global persistent tracking of used Pexels photo IDs ───
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', '..');
const USED_IDS_FILE = path.join(DATA_DIR, '.used-pexels-ids.json');
let globalUsedPhotoIds = new Set();

function loadUsedIds() {
  try {
    const data = fs.readFileSync(USED_IDS_FILE, 'utf8');
    const arr = JSON.parse(data);
    globalUsedPhotoIds = new Set(arr);
    console.log(`Loaded ${globalUsedPhotoIds.size} used Pexels photo IDs from disk.`);
  } catch (e) {
    globalUsedPhotoIds = new Set();
  }
}

function saveUsedIds() {
  try {
    // Keep last 500 IDs
    const arr = [...globalUsedPhotoIds];
    const trimmed = arr.slice(-500);
    globalUsedPhotoIds = new Set(trimmed);
    fs.writeFileSync(USED_IDS_FILE, JSON.stringify(trimmed), 'utf8');
  } catch (e) {
    console.error('Failed to save used Pexels IDs:', e.message);
  }
}

/**
 * Mark a Pexels photo ID as used (globally, persisted to disk).
 */
export function trackUsedPhoto(photoId) {
  globalUsedPhotoIds.add(photoId);
  saveUsedIds();
}

// Load on module init
loadUsedIds();

/**
 * Search for a stock photo on Pexels matching the article title/mood.
 * Uses Claude Haiku for smart, editorial-quality search queries.
 * Returns the best matching photo with URL and metadata.
 * Automatically excludes all previously used photos (global + session).
 * @param {string} title - Article title
 * @param {string} searchHints - Additional search hints
 * @param {number[]} excludeIds - Extra Pexels photo IDs to exclude (e.g. from current batch)
 */
export async function findFeatureImage(title, searchHints = '', excludeIds = []) {
  // Merge session excludeIds with global persistent set
  const allExcluded = new Set([...globalUsedPhotoIds, ...excludeIds]);

  // Use Haiku-powered smart query instead of regex keyword extraction
  const searchQuery = await generateImageQuery(title, searchHints);
  console.log(`[Pexels] Smart query: "${searchQuery}" for "${title.substring(0, 60)}..." (excluding ${allExcluded.size} used IDs)`);

  try {
    const res = await withRetry(
      () => pexelsClient.get('/search', {
        params: {
          query: searchQuery,
          orientation: 'landscape',
          size: 'large',
          per_page: 50,
        },
      }),
      { label: 'search' }
    );

    let photos = res.data.photos || [];

    if (photos.length === 0) {
      // Fallback with a simpler query
      const fallbackQuery = await generateImageQuery(title, 'simple generic lifestyle photo');
      console.log(`[Pexels] Fallback query: "${fallbackQuery}"`);
      const fallbackRes = await withRetry(
        () => pexelsClient.get('/search', {
          params: {
            query: fallbackQuery,
            orientation: 'landscape',
            size: 'large',
            per_page: 50,
          },
        }),
        { label: 'fallback search' }
      );
      photos = fallbackRes.data.photos || [];
    }

    if (photos.length === 0) return null;

    // Filter out ALL previously used photos (global + session)
    if (allExcluded.size > 0) {
      const filtered = photos.filter(p => !allExcluded.has(p.id));
      if (filtered.length > 0) {
        photos = filtered;
      } else {
        console.warn('[Pexels] All results were previously used! Falling back to full results.');
      }
    }

    const result = selectBestPhoto(photos);
    if (result) {
      console.log(`[Pexels] Selected photo ${result.id}: "${result.alt}" by ${result.photographer}`);
    }
    return result;
  } catch (e) {
    console.error('[Pexels] Search error:', e.message);
    return null;
  }
}

/**
 * Download a photo from Pexels as a buffer.
 */
export async function downloadPhoto(photoUrl) {
  try {
    const res = await withRetry(
      () => axios.get(photoUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      }),
      { label: 'download' }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.error('Error downloading photo:', e.message);
    return null;
  }
}

/**
 * Select the best photo from results.
 * Prefers: landscape, large enough, person visible.
 * Adds randomization among top candidates to avoid duplicate picks.
 */
function selectBestPhoto(photos) {
  // Filter for minimum 1200px wide
  const viable = photos.filter(p => p.width >= 1200);
  if (viable.length === 0 && photos.length > 0) {
    photos.sort((a, b) => b.width - a.width);
    return formatPhoto(photos[0]);
  }

  // Prefer photos closer to 1600px wide
  viable.sort((a, b) => {
    const aDist = Math.abs(a.width - 1600);
    const bDist = Math.abs(b.width - 1600);
    return aDist - bDist;
  });

  // Randomly pick from the top 5 candidates
  const topN = Math.min(5, viable.length);
  const randomIndex = Math.floor(Math.random() * topN);
  return formatPhoto(viable[randomIndex] || photos[0]);
}

function formatPhoto(photo) {
  let downloadUrl;
  if (photo.src.large2x) {
    downloadUrl = photo.src.large2x.replace(/w=\d+/, 'w=1600');
  } else {
    const base = photo.src.original.split('?')[0];
    downloadUrl = `${base}?auto=compress&cs=tinysrgb&w=1600`;
  }

  const aspectRatio = photo.height / photo.width;
  const downloadWidth = Math.min(photo.width, 1600);
  const downloadHeight = Math.round(downloadWidth * aspectRatio);

  return {
    id: photo.id,
    url: photo.src.large2x || photo.src.large || photo.src.original,
    downloadUrl,
    width: downloadWidth,
    height: downloadHeight,
    alt: photo.alt || 'Featured image',
    photographer: photo.photographer,
  };
}
