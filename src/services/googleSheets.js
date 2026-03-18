// Google Sheets integration — fetches author list from shared spreadsheet
// Uses lightweight JWT auth (no googleapis dependency) with service account credentials

import crypto from 'crypto';
import axios from 'axios';

const SPREADSHEET_ID = '1d8dUr3IVmJL73vwH6M6z1LuL_JABshsOaf0vAz4in3k';
const SHEET_NAME = 'Authors';     // Sheet tab name
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly';

let cachedAuthors = null;
let cachedAt = 0;
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Create a JWT and exchange it for a Google access token.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const keyB64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyB64) {
    console.warn('[GoogleSheets] No GOOGLE_SERVICE_ACCOUNT_KEY set — author sheet disabled');
    return null;
  }

  try {
    const keyJson = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf-8'));
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;

    // Build JWT header + payload
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: keyJson.client_email,
      scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp,
    })).toString('base64url');

    // Sign with RSA private key
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(keyJson.private_key, 'base64url');

    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    });

    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + (res.data.expires_in * 1000);
    return cachedToken;
  } catch (e) {
    console.error(`[GoogleSheets] Auth failed: ${e.message}`);
    return null;
  }
}

/**
 * Fetch all authors from the spreadsheet.
 * Expected columns: Name | Domain | WP User ID | WP Author Slug | Bio/Notes | Active
 * Returns array of { name, domain, wpUserId, wpAuthorSlug, bio, active }
 */
async function fetchAllAuthors() {
  if (cachedAuthors && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedAuthors;
  }

  const token = await getAccessToken();
  if (!token) return null;

  try {
    const range = encodeURIComponent(`${SHEET_NAME}!A:F`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const rows = res.data.values;
    if (!rows || rows.length < 2) {
      console.warn('[GoogleSheets] No data found in Authors sheet');
      return [];
    }

    const headers = rows[0].map(h => h.toLowerCase().trim());
    const nameIdx = headers.findIndex(h => h.includes('name'));
    const domainIdx = headers.findIndex(h => h.includes('domain') || h.includes('site'));
    const wpUserIdIdx = headers.findIndex(h => h.includes('user id') || h.includes('userid') || h.includes('wp id'));
    const slugIdx = headers.findIndex(h => h.includes('slug'));
    const bioIdx = headers.findIndex(h => h.includes('bio') || h.includes('note'));
    const activeIdx = headers.findIndex(h => h.includes('active') || h.includes('enabled'));

    const authors = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[nameIdx]) continue;

      const activeVal = activeIdx >= 0 ? (row[activeIdx] || '').toLowerCase().trim() : 'yes';
      if (activeVal === 'no' || activeVal === 'false' || activeVal === '0') continue;

      authors.push({
        name: row[nameIdx]?.trim() || '',
        domain: (domainIdx >= 0 ? row[domainIdx]?.trim() : '') || '',
        wpUserId: wpUserIdIdx >= 0 ? parseInt(row[wpUserIdIdx]) || null : null,
        wpAuthorSlug: slugIdx >= 0 ? (row[slugIdx]?.trim() || '') : '',
        bio: bioIdx >= 0 ? (row[bioIdx]?.trim() || '') : '',
        active: true,
      });
    }

    cachedAuthors = authors;
    cachedAt = Date.now();
    console.log(`[GoogleSheets] Loaded ${authors.length} active authors from sheet`);
    return authors;
  } catch (e) {
    console.error(`[GoogleSheets] Failed to fetch authors: ${e.message}`);
    return null;
  }
}

/**
 * Get authors for a specific domain.
 */
export async function getAuthorsForDomain(domain) {
  const all = await fetchAllAuthors();
  if (!all) return null;

  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return all.filter(a => {
    const aDomain = a.domain.toLowerCase().replace(/^www\./, '');
    return aDomain === normalized || aDomain.includes(normalized) || normalized.includes(aDomain);
  });
}

/**
 * Get all authors across all domains.
 */
export async function getAllAuthors() {
  return await fetchAllAuthors();
}

/**
 * Force refresh the author cache.
 */
export function clearAuthorCache() {
  cachedAuthors = null;
  cachedAt = 0;
}
