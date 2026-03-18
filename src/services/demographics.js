/**
 * Author Demographics Service
 *
 * Three-layer system for maintaining author demographic accuracy:
 * 1. Google Sheet sync — master source of truth (age, name, site)
 * 2. Local JSON cache — enriched with gender, family context, learned details
 * 3. Deterministic validation — hard checks before any LLM-based validation
 *
 * Google Sheet: https://docs.google.com/spreadsheets/d/1d8dUr3IVmJL73vwH6M6z1LuL_JABshsOaf0vAz4in3k
 * Tab: "Author Info" (gid=638694607)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '..', '..', 'data', 'author-demographics.json');

// Google Sheet CSV export URL
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1d8dUr3IVmJL73vwH6M6z1LuL_JABshsOaf0vAz4in3k/export?format=csv&gid=638694607';

// Site code → domain mapping
const SITE_DOMAINS = {
  'ARP': 'artfulparent.com',
  'EE': 'experteditor.com.au',
  'GEE': 'geediting.com',
  'SC': 'siliconcanals.com',
  'TV': 'thevessel.io',
  'TYB': 'tweakyourbiz.com',
  'VO': 'vegoutmag.com',
  'DM': 'dmnews.com',
  'BB': 'brownbrothers.io',
};

// Fallback data from the Sheet (Feb 2026) — used if Sheet fetch fails on first run
const SEED_DATA = {
  'artfulparent.com': {
    'Allison': { age: 35, gender: 'female' },
    'Justin': { age: 44, gender: 'male' },
    'Lachlan': { age: 37, gender: 'male' },
    'Tony': { age: 63, gender: 'male' },
  },
  'experteditor.com.au': {
    'Diane': { age: 72, gender: 'female' },
    'Farley': { age: 65, gender: 'male' },
    'Justin': { age: 44, gender: 'male' },
    'Lachlan': { age: 37, gender: 'male' },
    'Tina': { age: 43, gender: 'female' },
  },
  'geediting.com': {
    'Cole': { age: 36, gender: 'male' },
    'Farley': { age: 65, gender: 'male' },
    'Helen': { age: 63, gender: 'female' },
    'Isabella': { age: 38, gender: 'female' },
    'Justin': { age: 44, gender: 'male' },
    'Lachlan': { age: 37, gender: 'male' },
    'Margot': { age: 73, gender: 'female' },
    'Tony': { age: 66, gender: 'male' },
  },
  'siliconcanals.com': {
    'Tommy': { age: 66, gender: 'male' },
    'Christian': { age: 44, gender: 'male' },
    'James': { age: 34, gender: 'male' },
    'Justin': { age: 44, gender: 'male' },
    'Lachlan': { age: 37, gender: 'male' },
    'Sarah': { age: 34, gender: 'female' },
  },
  'thevessel.io': {
    'Isabella': { age: 38, gender: 'female' },
    'Justin': { age: 44, gender: 'male' },
    'Lachlan': { age: 37, gender: 'male' },
    'Una': { age: 70, gender: 'female' },
  },
  'tweakyourbiz.com': {
    'Claire': { age: 37, gender: 'female' },
    'John': { age: 64, gender: 'male' },
    'Justin': { age: 44, gender: 'male' },
    'Paul': { age: 41, gender: 'male' },
  },
  'vegoutmag.com': {
    'Gerry': { age: 62, gender: 'male' },
    'Adam': { age: 36, gender: 'male' },
    'Avery': { age: 42, gender: 'female' },
    'Jordan': { age: 44, gender: 'male' },
    'Justin': { age: 44, gender: 'male' },
  },
  'dmnews.com': {
    'Justin': { age: 44, gender: 'male' },
  },
  'brownbrothers.io': {
    'Justin': { age: 44, gender: 'male' },
  },
};

// In-memory demographics store
let demographics = {};
let lastSheetSync = null;

/**
 * Initialize demographics — load local cache, then sync from Sheet.
 * Call this on bot startup.
 */
export async function initDemographics() {
  // Step 1: Load local cache if it exists
  loadLocalCache();

  // Step 2: If no local cache, use seed data
  if (Object.keys(demographics).length === 0) {
    console.log('[Demographics] No local cache found, using seed data');
    demographics = JSON.parse(JSON.stringify(SEED_DATA));
    saveLocalCache();
  }

  // Step 3: Sync from Google Sheet (non-blocking — don't fail startup)
  try {
    await syncFromSheet();
  } catch (err) {
    console.error('[Demographics] Sheet sync failed on startup (using cached data):', err.message);
  }

  console.log(`[Demographics] Initialized with ${countAuthors()} authors across ${Object.keys(demographics).length} sites`);
}

/**
 * Start periodic Sheet sync (every 6 hours).
 */
export function startPeriodicSync(intervalMs = 6 * 60 * 60 * 1000) {
  setInterval(async () => {
    try {
      console.log('[Demographics] Periodic Sheet sync...');
      await syncFromSheet();
    } catch (err) {
      console.error('[Demographics] Periodic sync failed:', err.message);
    }
  }, intervalMs);
}

/**
 * Get demographics for an author on a specific site.
 * @param {string} authorName - Full name or first name
 * @param {string} domain - Site domain (e.g. "geediting.com")
 * @returns {object|null} { age, gender, familyContext, background, learned } or null
 */
export function getDemographics(authorName, domain) {
  const firstName = authorName.split(/\s+/)[0];
  const siteData = demographics[domain];
  if (!siteData) return null;

  // Try exact first name match
  if (siteData[firstName]) return { firstName, ...siteData[firstName] };

  // Try case-insensitive
  const key = Object.keys(siteData).find(k => k.toLowerCase() === firstName.toLowerCase());
  if (key) return { firstName: key, ...siteData[key] };

  return null;
}

/**
 * Deterministic demographic validation — hard checks, no LLM needed.
 * Returns contradictions found in the title vs known demographics.
 *
 * @param {string} title - Article title to check
 * @param {object} authorDemographics - From getDemographics()
 * @returns {{ pass: boolean, contradictions: string[], suggestedFix: string|null }}
 */
export function validateTitleDemographics(title, authorDemographics) {
  if (!authorDemographics) {
    return { pass: true, contradictions: [], suggestedFix: null };
  }

  const contradictions = [];
  const { age, gender } = authorDemographics;
  const titleLower = title.toLowerCase();

  // === AGE CHECKS ===
  if (age) {
    // Extract age claims from title: "I'm XX", "at XX,", "XX years", "XX-year-old", "in my XXs"
    const agePatterns = [
      /\bI'm\s+(\d{1,3})\b/i,
      /\bI am\s+(\d{1,3})\b/i,
      /\bat\s+(\d{1,3})[,\s]/i,
      /\b(\d{1,3})[\s-]year[\s-]old\b/i,
      /\bturned?\s+(\d{1,3})\b/i,
      /\bage\s+(\d{1,3})\b/i,
      /\bturning\s+(\d{1,3})\b/i,
    ];

    for (const pattern of agePatterns) {
      const match = title.match(pattern);
      if (match) {
        const claimedAge = parseInt(match[1], 10);
        const ageDiff = Math.abs(claimedAge - age);
        // Allow ±3 years tolerance (rounding, birthday timing)
        if (ageDiff > 3) {
          contradictions.push(
            `Title claims age ${claimedAge} but author is ${age} (${ageDiff} years off)`
          );
        }
      }
    }

    // Check decade claims: "in my seventies", "in their 60s", "late fifties", etc.
    const decadeWords = {
      'twenties': [20, 29], 'thirties': [30, 39], 'forties': [40, 49],
      'fifties': [50, 59], 'sixties': [60, 69], 'seventies': [70, 79],
      'eighties': [80, 89], 'nineties': [90, 99],
    };
    // Match "in my 60s", "in their 70s", "your 50s", etc.
    const decadeNumPatterns = [
      /\b(?:in\s+)?(?:my|their|your|his|her)\s+(\d)0s\b/i,
      /\b(?:late|early|mid)[- ](\d)0s\b/i,
      /\bpeople\s+(?:in\s+their|over)\s+(\d)0\b/i,
    ];
    // Match "in my fifties", "their late sixties", "people in their seventies", etc.
    const decadeWordPatterns = [
      /\b(?:in\s+)?(?:my|their|your|his|her)\s+(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/i,
      /\b(?:late|early|mid)[- ](twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/i,
      /\bpeople\s+(?:in\s+their)\s+(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/i,
    ];

    for (const pattern of decadeNumPatterns) {
      const match = title.match(pattern);
      if (match) {
        const decadeStart = parseInt(match[1], 10) * 10;
        if (age < decadeStart || age >= decadeStart + 10) {
          contradictions.push(
            `Title references "${match[0]}" but author is ${age}`
          );
        }
      }
    }

    for (const pattern of decadeWordPatterns) {
      const match = title.match(pattern);
      if (match) {
        const [low, high] = decadeWords[match[1].toLowerCase()];
        if (age < low || age > high) {
          contradictions.push(
            `Title references "${match[0]}" but author is ${age}`
          );
        }
      }
    }

    // Check life stage claims
    if (age < 55 && /\bretired\b/i.test(title)) {
      contradictions.push(`Title mentions "retired" but author is only ${age}`);
    }
    if (age < 45 && /\bgrandchild|grandkid|grandparent|grandmother|grandfather|granddaughter|grandson|grandpa|grandma|nana|papa\b/i.test(title)) {
      contradictions.push(`Title mentions grandchildren but author is only ${age}`);
    }
    if (age > 55 && /\bnew graduate|just graduated|fresh out of college|first job\b/i.test(title)) {
      contradictions.push(`Title implies recent graduate but author is ${age}`);
    }
    // Catch "X years" duration claims — "spent thirty years" implies at least ~48 years old
    const yearsWordToNum = {
      twenty: 20, thirty: 30, forty: 40, fifty: 50,
      'twenty-five': 25, 'thirty-five': 35, 'forty-five': 45,
    };
    const yearsMatch = title.match(/\b(?:after|for|spent)\s+(twenty|thirty|forty|fifty|twenty-five|thirty-five|forty-five|\d{2,})\s+years?\b/i);
    if (yearsMatch) {
      const yearsNum = yearsWordToNum[yearsMatch[1].toLowerCase()] || parseInt(yearsMatch[1], 10);
      if (yearsNum) {
        const impliedMinAge = yearsNum + 18; // started as adult
        if (impliedMinAge > age + 5) {
          contradictions.push(
            `Title claims "${yearsMatch[0]}" implying min age ~${impliedMinAge}, but author is ${age}`
          );
        }
      }
    }

    // Catch "after X decades" patterns — "after three decades" implies 50+ years old
    const decadesMatch = title.match(/\b(?:after|for|spent)\s+(?:three|four|five|six|seven|3|4|5|6|7)\s+decades?\b/i);
    if (decadesMatch) {
      const wordToNum = { three: 3, four: 4, five: 5, six: 6, seven: 7 };
      const numStr = decadesMatch[0].match(/(?:three|four|five|six|seven|[3-7])/i)?.[0];
      const decades = wordToNum[numStr?.toLowerCase()] || parseInt(numStr, 10) || 0;
      const impliedMinAge = decades * 10 + 18; // e.g. "three decades" implies at least ~48
      if (impliedMinAge > age + 5) {
        contradictions.push(`Title implies ${decades} decades of experience (min age ~${impliedMinAge}) but author is ${age}`);
      }
    }
  }

  // === GENDER CHECKS ===
  if (gender) {
    // First-person spousal references
    if (gender === 'female') {
      if (/\bmy wife\b/i.test(title) && !/\bex[\s-]wife\b/i.test(title)) {
        contradictions.push('Title says "my wife" but author is female (implies male narrator)');
      }
      if (/\bas a father\b/i.test(title) || /\bas a dad\b/i.test(title)) {
        contradictions.push('Title says "as a father/dad" but author is female');
      }
      if (/\bI'm a.*\bhusband\b/i.test(title)) {
        contradictions.push('Title claims to be a husband but author is female');
      }
    }
    if (gender === 'male') {
      if (/\bmy husband\b/i.test(title) && !/\bex[\s-]husband\b/i.test(title)) {
        contradictions.push('Title says "my husband" but author is male (implies female narrator)');
      }
      if (/\bas a mother\b/i.test(title) || /\bas a mom\b/i.test(title)) {
        contradictions.push('Title says "as a mother/mom" but author is male');
      }
      if (/\bI'm a.*\bwife\b/i.test(title)) {
        contradictions.push('Title claims to be a wife but author is male');
      }
    }
  }

  return {
    pass: contradictions.length === 0,
    contradictions,
    suggestedFix: contradictions.length > 0
      ? `Title has ${contradictions.length} demographic contradiction(s) with author (age: ${age || 'unknown'}, gender: ${gender || 'unknown'}). Needs adaptation.`
      : null,
  };
}

/**
 * Update learned demographics for an author after analyzing their articles.
 * Merges new info without overwriting Sheet-sourced data (age, gender).
 */
export function updateLearnedDemographics(authorName, domain, learned) {
  const firstName = authorName.split(/\s+/)[0];
  if (!demographics[domain]) demographics[domain] = {};
  if (!demographics[domain][firstName]) demographics[domain][firstName] = {};

  const existing = demographics[domain][firstName];

  // Only update learned fields — never overwrite age/gender from Sheet
  if (learned.familyContext && !existing._sheetFamilyContext) {
    existing.familyContext = learned.familyContext;
  }
  if (learned.background && !existing._sheetBackground) {
    existing.background = learned.background;
  }
  if (learned.interests) {
    existing.interests = learned.interests;
  }
  if (learned.writingTopics) {
    existing.writingTopics = learned.writingTopics;
  }

  // Track what was learned and when
  if (!existing.learned) existing.learned = {};
  existing.learned.lastUpdated = new Date().toISOString();
  if (learned.familyContext) existing.learned.familyContext = learned.familyContext;
  if (learned.background) existing.learned.background = learned.background;

  saveLocalCache();
  console.log(`[Demographics] Updated learned data for ${firstName} on ${domain}`);
}

// === Internal functions ===

/**
 * Fetch and parse the Google Sheet CSV, merge into demographics.
 */
async function syncFromSheet() {
  console.log('[Demographics] Syncing from Google Sheet...');

  const response = await fetch(SHEET_CSV_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArticleBot/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Sheet export failed: ${response.status} ${response.statusText}`);
  }

  const csv = await response.text();
  const rows = parseCSV(csv);

  if (rows.length < 2) {
    throw new Error(`Sheet returned too few rows (${rows.length})`);
  }

  let updated = 0;
  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    const [siteCode, name, ageStr] = rows[i];
    if (!siteCode || !name) continue;

    const domain = SITE_DOMAINS[siteCode.trim().toUpperCase()];
    if (!domain) {
      console.warn(`[Demographics] Unknown site code: "${siteCode}"`);
      continue;
    }

    const firstName = name.trim().split(/\s+/)[0];
    const age = parseInt(ageStr, 10);
    if (!firstName || isNaN(age)) continue;

    if (!demographics[domain]) demographics[domain] = {};
    if (!demographics[domain][firstName]) demographics[domain][firstName] = {};

    const existing = demographics[domain][firstName];
    const oldAge = existing.age;

    // Sheet is authoritative for age
    existing.age = age;
    existing._sheetAge = true;
    existing.lastSheetSync = new Date().toISOString();

    // Preserve existing gender and learned data
    if (!existing.gender) {
      // Try to infer from seed data
      const seed = SEED_DATA[domain]?.[firstName];
      if (seed?.gender) existing.gender = seed.gender;
    }

    if (oldAge !== age) {
      console.log(`[Demographics] ${firstName}@${domain}: age ${oldAge || 'unknown'} → ${age}`);
    }
    updated++;
  }

  lastSheetSync = new Date().toISOString();
  saveLocalCache();
  console.log(`[Demographics] Sheet sync complete: ${updated} authors processed, ${countAuthors()} total`);
}

/**
 * Simple CSV parser (handles quoted fields).
 */
function parseCSV(csv) {
  const lines = csv.split('\n');
  return lines.map(line => {
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  }).filter(row => row.some(cell => cell.length > 0));
}

function loadLocalCache() {
  try {
    if (existsSync(CACHE_PATH)) {
      const data = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
      demographics = data.demographics || {};
      lastSheetSync = data.lastSheetSync || null;
      console.log(`[Demographics] Loaded local cache (${countAuthors()} authors, last sync: ${lastSheetSync || 'never'})`);
    }
  } catch (err) {
    console.error('[Demographics] Failed to load local cache:', err.message);
  }
}

function saveLocalCache() {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(CACHE_PATH, JSON.stringify({
      demographics,
      lastSheetSync,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.error('[Demographics] Failed to save local cache:', err.message);
  }
}

function countAuthors() {
  return Object.values(demographics).reduce(
    (sum, site) => sum + Object.keys(site).length, 0
  );
}
