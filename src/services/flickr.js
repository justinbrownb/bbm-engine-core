import axios from 'axios';
import { generateImageQuery } from '../utils/imageQuery.js';

const FLICKR_API_URL = 'https://api.flickr.com/services/rest';

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
      console.log(`[Flickr] ${label} failed (${status || e.code || 'network'}), retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Search Flickr for Creative Commons-licensed images on a topic.
 * Uses Claude Haiku for smart, editorial-quality search queries.
 * Returns the best match, or null if nothing suitable found.
 * CC License IDs: 1=BY-NC-SA, 2=BY-NC, 4=BY, 5=BY-SA, 6=BY-ND, 9=CC0
 */
export async function findFlickrImage(topic, excludeIds = []) {
  const apiKey = process.env.FLICKR_API_KEY;
  if (!apiKey) return null;

  // Use smart query for Flickr too
  const query = await generateImageQuery(topic, 'creative commons photography');
  console.log(`[Flickr] Smart query: "${query}" for "${topic.substring(0, 60)}..."`);

  try {
    const res = await withRetry(
      () => axios.get(FLICKR_API_URL, {
        params: {
          method: 'flickr.photos.search',
          api_key: apiKey,
          text: query,
          license: '1,2,4,5,6,9',
          sort: 'relevance',
          per_page: 30,
          extras: 'url_l,url_o,url_c,owner_name,license',
          content_type: 1, // photos only
          media: 'photos',
          format: 'json',
          nojsoncallback: 1,
        },
        timeout: 15000,
      }),
      { label: 'search' }
    );

    const photos = res.data?.photos?.photo;
    if (!photos || photos.length === 0) {
      console.log(`[Flickr] No results for "${query}"`);
      return null;
    }

    // Filter out already-used photos, and those without a usable URL
    const excludeSet = new Set(excludeIds.map(String));
    const candidates = photos.filter(p => {
      if (excludeSet.has(String(p.id))) return false;
      return p.url_l || p.url_o || p.url_c;
    });

    if (candidates.length === 0) return null;

    // Pick from top 5 candidates randomly for variety
    const topN = candidates.slice(0, 5);
    const pick = topN[Math.floor(Math.random() * topN.length)];

    const downloadUrl = pick.url_l || pick.url_o || pick.url_c;

    console.log(`[Flickr] Selected photo ${pick.id}: "${pick.title || 'untitled'}" by ${pick.ownername || 'unknown'}`);

    return {
      id: pick.id,
      downloadUrl,
      alt: pick.title || topic,
      photographer: pick.ownername || 'Unknown',
      license: pick.license,
      width: pick.width_l || pick.width_o || pick.width_c || 0,
      height: pick.height_l || pick.height_o || pick.height_c || 0,
      source: 'flickr',
    };
  } catch (e) {
    console.error(`[Flickr] Search error: ${e.message}`);
    return null;
  }
}

/**
 * Download a Flickr photo as a buffer.
 */
export async function downloadFlickrPhoto(photoUrl) {
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
    console.error(`[Flickr] Download error: ${e.message}`);
    return null;
  }
}
