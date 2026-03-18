// Personal details registry — engines register their author detail banks at startup.
// Utils (bioValidator, titleBioGuard, articleRewriter, detailSelector) read from here.

let _personalDetailBanks = {};

/**
 * Register personal detail banks for all authors.
 * Call this once at engine startup, passing the engine's personalDetails export.
 * @param {Object} banks - { 'Author Name': 'detail bank text', ... }
 */
export function registerPersonalDetails(banks) {
  _personalDetailBanks = banks;
}

/**
 * Get the personal detail bank for a specific author.
 * @param {string} authorName
 * @returns {string|null}
 */
export function getPersonalDetails(authorName) {
  return _personalDetailBanks[authorName] || null;
}

/**
 * Get all registered personal detail banks.
 * @returns {Object}
 */
export function getAllPersonalDetails() {
  return _personalDetailBanks;
}
