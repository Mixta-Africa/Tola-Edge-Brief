/**
 * Relevance Scorer — the trust gate.
 *
 * Replaces loose substring matching (which let "land" match "Switzerland" and
 * let articles glancing off weak words like "building" into the briefing).
 *
 * Rules:
 *  - Word-boundary matching only (no more Switzerland -> land).
 *  - Tiered keywords: an article must hit at least one STRONG or MEDIUM term;
 *    weak-only matches are rejected.
 *  - Hard exclusions (sports especially) are rejected outright.
 *  - Returns an auditable verdict so we can log WHY anything passed or failed.
 */

// STRONG: unambiguous real-estate signal
const STRONG = [
  'real estate', 'real-estate', 'property', 'properties', 'housing',
  'mortgage', 'lekki', 'ibeju-lekki', 'ibeju lekki', 'ikoyi',
  'real estate developer', 'property developer', 'property market',
  'housing market', 'reit', 'landlord', 'tenancy', 'homebuyer',
  'homebuyers', 'shortlet', 'short-let', 'housing deficit', 'housing estate',
];

// MEDIUM: real-estate in most contexts
const MEDIUM = [
  'developer', 'residential', 'apartment', 'duplex', 'rent', 'rental',
  'land', 'plot', 'estate', 'urban development', 'certificate of occupancy',
  'c of o', 'allocation', 'real estate sector', 'land use', 'land allocation',
  'estate agent', 'realty', 'bungalow', 'terrace', 'serviced plot',
  'homes', 'housing units', 'affordable homes',
];

// WEAK: only meaningful alongside a STRONG/MEDIUM term
const WEAK = [
  'building', 'commercial', 'office', 'home', 'house', 'houses',
  'construction', 'infrastructure', 'development',
];

// HARD EXCLUSIONS: if present, reject regardless (these are never real estate)
const EXCLUDE = [
  'world cup', 'fifa', 'afcon', 'premier league', 'la liga', 'serie a',
  'champions league', 'football', 'striker', 'midfielder', 'goalkeeper',
  'goalless', 'kick-off', 'fixture', 'qualifier', 'super eagles',
  'nba', 'tennis', 'golf tournament', 'wrestling', 'boxing match',
  'sodomy', 'rape', 'pornography',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cache compiled regexes
const _cache = new Map();
function wordRegex(term) {
  if (_cache.has(term)) return _cache.get(term);
  // \b works at phrase edges too; for terms with internal spaces this is fine
  const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
  _cache.set(term, re);
  return re;
}

function countHits(text, terms) {
  const hits = [];
  for (const term of terms) {
    if (wordRegex(term).test(text)) hits.push(term);
  }
  return hits;
}

/**
 * Full verdict for the authoritative Phase 2 gate.
 * Returns { passed, score, strong, medium, weak, excludedBy, reason }
 */
function scoreRelevance(title = '', description = '') {
  const t = (title || '').toLowerCase();
  const d = (description || '').toLowerCase().substring(0, 600);
  const combined = `${t} ${d}`;

  // Hard exclusion first
  const excl = countHits(combined, EXCLUDE);
  if (excl.length) {
    return { passed: false, score: 0, strong: [], medium: [], weak: [], excludedBy: excl, reason: `excluded (${excl[0]})` };
  }

  // Title hits weigh double
  const strongTitle = countHits(t, STRONG);
  const mediumTitle = countHits(t, MEDIUM);
  const strongAll = countHits(combined, STRONG);
  const mediumAll = countHits(combined, MEDIUM);
  const weakAll = countHits(combined, WEAK);

  const score =
    strongTitle.length * 6 + (strongAll.length - strongTitle.length) * 3 +
    mediumTitle.length * 4 + (mediumAll.length - mediumTitle.length) * 2 +
    weakAll.length * 1;

  // Must have at least one strong or medium term somewhere
  const hasAnchor = strongAll.length > 0 || mediumAll.length > 0;

  if (!hasAnchor) {
    return {
      passed: false, score, strong: strongAll, medium: mediumAll, weak: weakAll,
      excludedBy: [], reason: weakAll.length ? 'weak-only match' : 'no real-estate terms',
    };
  }

  return {
    passed: true, score, strong: strongAll, medium: mediumAll, weak: weakAll,
    excludedBy: [], reason: 'ok',
  };
}

/**
 * Lenient boolean for feed-level pre-filtering (reduces volume cheaply).
 * Word-boundary, any tier, but still respects hard exclusions.
 */
function quickMatch(title = '', description = '') {
  const combined = `${(title || '').toLowerCase()} ${(description || '').toLowerCase().substring(0, 400)}`;
  if (countHits(combined, EXCLUDE).length) return false;
  return (
    countHits(combined, STRONG).length > 0 ||
    countHits(combined, MEDIUM).length > 0 ||
    countHits(combined, WEAK).length > 0
  );
}

module.exports = { scoreRelevance, quickMatch };
