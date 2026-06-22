/**
 * Tola Edge Brief — Thought Leadership Track Engine
 * Runs inside GitHub Actions (Node 20 + ubuntu-latest). Never runs in the browser.
 *
 * THIS IS A COMPLETELY SEPARATE TRACK FROM THE DAILY COMMERCIAL BRIEF (engine.js).
 *
 * Per Tola_Edge_Brief_Thought_Leadership_Track.md:
 *   "The daily commercial brief (v2) works because every story has to pass
 *   one test: a specific, named mechanism connecting it to Mixta's P&L. The
 *   moment that test gets an 'or it's relevant to Tola's thought leadership'
 *   escape hatch, the discipline that just fixed yesterday's brief erodes —
 *   almost any story can be justified as 'interesting for thought
 *   leadership' if the bar is soft. Keeping the two tracks on separate
 *   prompts, separate cadences, and separate UI sections means each test
 *   stays sharp."
 *
 * Consequences of that design decision, enforced structurally here:
 *   - This file does NOT import or call anything from engine.js, and
 *     engine.js does NOT import or call anything from this file. The only
 *     code shared between the two tracks is the domain-agnostic plumbing
 *     in lib/ (LLM transport, RSS/news fetching, Puppeteer enrichment) —
 *     none of which contains a relevance test, a prompt, or any Mixta P&L
 *     judgment logic.
 *   - This engine applies NO Mixta commercial relevance test. See
 *     buildThoughtLeadershipPrompt() below for the actual (different)
 *     relevance test used here.
 *   - Output is written to a path that NEVER intersects the commercial
 *     vault: vault/thought-leadership/ (vs vault/ for daily commercial
 *     briefs), and to /tmp/tl_brief_output.json (vs /tmp/brief_output.json).
 *
 * Cadence: weekly (see .github/workflows/generate-thought-leadership.yml),
 * not daily. Triggered by its own cron schedule or its own
 * "Generate Weekly Thought Leadership Brief" button in the UI — never by
 * the daily commercial "Generate" button.
 *
 * Four-phase pipeline (no Phase 4 LLM-per-article analysis step — this
 * track skips straight from enrichment to synthesis, since there's no
 * Mixta-relevance pre-scoring to do per article; the synthesis prompt's
 * own relevance test does all the judgment in one pass):
 *   Phase 1 — Fetch:    GNews + NewsAPI + Google News RSS + curated RSS feeds,
 *                        scoped by Local/Global market toggle
 *   Phase 2 — Filter:   Dedupe + housing-finance-for-non-traditional-income
 *                        keyword scoring (different keyword set than the
 *                        commercial engine's domain keywords)
 *   Phase 3 — Enrich:   Puppeteer full-text extraction (shared lib)
 *   Phase 4 — Synthesize: weekly findings JSON schema (four pillars)
 *   Output  — Write /tmp/tl_brief_output.json → workflow commits to main's data/
 *             under vault/thought-leadership/
 *
 * GitHub Secrets consumed (same pool as the commercial engine — these are
 * generic API keys, not commercial-brief-specific):
 *   GNEWS_API_KEY, NEWSAPI_KEY,
 *   GROQ_API_KEY, SAMBANOVA_API_KEY, CEREBRAS_API_KEY,
 *   MISTRAL_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { sleep, runChain, synthesisProviders } = require('./lib/providers');
const { fetchGNews, fetchNewsAPI, fetchGoogleNewsRSS, fetchRSSFeed, cleanContent, runFetchesInBatches } = require('./lib/fetchers');
const { enrichArticles } = require('./lib/enrichment');

// ─── ENV ─────────────────────────────────────────────────────────────────────

const REQUEST_ID = process.env.REQUEST_ID || String(Date.now());
// SCOPE is this track's own toggle — Local or Global — entirely separate
// from the commercial engine's ACTIVE_MARKET (Nigeria/Senegal/All).
const SCOPE = (process.env.TL_SCOPE || 'Local').trim(); // 'Local' | 'Global'

// ─── PILLARS ──────────────────────────────────────────────────────────────────

const PILLARS = [
  'System Design & Policy',
  'Capital & Instruments',
  'Delivery & Partnerships',
  'Household Outcomes & Measurement',
];

// Keyword set distinct from the commercial engine's DOMAIN_KEYWORDS — this
// scores for "housing finance system serving non-traditional income," not
// for Mixta-specific commercial signals.
// NOTE: Use terms that actually appear in Nigerian/Senegalese news copy,
// not only the academic/Western terminology in the spec — "rent-to-own" and
// "shared equity" are rare in local headlines; "affordable housing", "low
// income", "NHF", "informal" are common.
const THESIS_KEYWORDS = [
  // Academic/international terms (appear in DFI/policy press releases)
  'rent-to-own', 'shared equity', 'alternative underwriting', 'employer-backed housing',
  'housing finance', 'microfinance housing', 'cooperative housing', 'housing subsidy',
  'financial inclusion', 'income volatility', 'underwriting model', 'workforce housing',
  'logement abordable', 'financement participatif', 'micro-hypothèque',
  // Nigerian vernacular terms (appear in local news)
  'affordable housing', 'low income housing', 'mass housing', 'social housing',
  'informal sector', 'informal income', 'gig worker', 'gig economy',
  'NHF', 'FMBN', 'MREIF', 'BOI housing', 'pension fund housing',
  'cooperative society', 'housing cooperative', 'off-plan', 'rent to own',
  'housing loan', 'mortgage access', 'homeownership', 'housing deficit',
  'housing scheme', 'federal housing', 'estate development', 'public housing',
  // Senegal French terms
  'logement', 'habitat', 'BCEAO financement', 'programme logement',
  // Outcome / measurement terms
  'housing stability', 'productivity housing', 'household income', 'workforce productivity',
  'DFI housing', 'guarantee scheme', 'pension housing', 'employer housing',
];

// ─── QUERY BUILDING (scope-aware: Local vs Global) ───────────────────────────

const LOCAL_QUERIES = [
  'Nigeria housing finance informal sector gig workers',
  'Nigeria affordable housing low income mortgage',
  'Nigeria rent-to-own shared equity housing model',
  'Nigeria employer-backed housing scheme cooperative',
  'Nigeria NHF FMBN housing loan access',
  'Nigeria MREIF BOI housing finance innovation',
  'Nigeria housing deficit homeownership mass market',
  'Senegal logement abordable financement habitat',
];

const AFRICA_COMPARATIVE_QUERIES = [
  'Kenya affordable housing finance informal income',
  'Ghana mortgage innovation informal sector',
  'South Africa housing finance gig economy',
  'Rwanda affordable housing finance model',
];

const MATURE_MARKET_QUERIES = [
  'United States rent-to-own shared equity housing model',
  'UK alternative mortgage underwriting gig economy',
  'United States housing finance gig worker freelancer',
  'UK shared ownership housing scheme',
];

/**
 * Returns a flat array of { pillarHint, query } — pillarHint is a loose
 * suggestion only (synthesis still decides the real pillar), used purely
 * to keep query construction organised, not as a hard filter.
 */
function buildThoughtLeadershipQueries() {
  const queries = [...LOCAL_QUERIES];

  if (SCOPE === 'Global') {
    queries.push(...AFRICA_COMPARATIVE_QUERIES, ...MATURE_MARKET_QUERIES);
  }

  return queries;
}

const NIGERIA_RSS_FEEDS = [
  'https://businessday.ng/feed/',
  'https://nairametrics.com/feed/',
];

const SENEGAL_RSS_FEEDS = [
  'https://www.lesoleil.sn/feed/',
];

// ─── PHASE 1: FETCH ───────────────────────────────────────────────────────────

async function fetchAllArticles() {
  console.log(`[TL Phase 1] Fetching articles — scope: ${SCOPE}...`);
  const queries = buildThoughtLeadershipQueries();
  console.log(`[TL Phase 1] ${queries.length} queries (Local base${SCOPE === 'Global' ? ' + Africa comparative + mature market' : ' only'})`);

  const apiFetches = [
    ...queries.map(q => fetchGNews(q, { country: 'ng', lang: 'en' })),
    ...queries.map(q => fetchNewsAPI(q)),
    ...queries.map(q => fetchGoogleNewsRSS(q, { hl: 'en-NG', gl: 'NG', ceid: 'NG:en' })),
  ];

  const directFeedFetches = [
    ...NIGERIA_RSS_FEEDS.map(f => fetchRSSFeed(f)),
    ...SENEGAL_RSS_FEEDS.map(f => fetchRSSFeed(f)),
  ];

  const results = await runFetchesInBatches([...apiFetches, ...directFeedFetches], 8, 500);
  console.log(`[TL Phase 1] Raw articles fetched: ${results.length}`);
  return results;
}

// ─── PHASE 2: FILTER (thesis-keyword scoring, NOT Mixta domain scoring) ──────

const ARTICLE_CAP = 20; // smaller than commercial — this track targets 4-6
                         // findings (quality over volume per spec), so it
                         // doesn't need as large a candidate pool.

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (!a.title || !a.url) return false;
    const key = a.url.split('?')[0].toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    const titleKey = a.title.toLowerCase().substring(0, 60);
    if (seen.has(titleKey)) return false;
    seen.add(titleKey);
    return true;
  });
}

function scoreThesisRelevance(article) {
  const text = `${article.title} ${article.description} ${article.content}`.toLowerCase();
  let score = 0;

  THESIS_KEYWORDS.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 3; });

  // General housing/finance terms get a smaller bonus — present but not
  // sufficient on their own (matches the spec: "a story about general real
  // estate price trends with no connection to financing models... does not
  // belong here").
  const generalTerms = ['housing', 'mortgage', 'real estate', 'finance', 'homeownership'];
  generalTerms.forEach(kw => { if (text.includes(kw)) score += 1; });

  return score;
}

function filterAndRankArticles(articles) {
  const deduped = deduplicateArticles(articles);
  const scored = deduped
    .map(a => ({ ...a, relevanceScore: scoreThesisRelevance(a) }))
    // Threshold of 1 — any keyword match passes to synthesis. The synthesis
    // prompt's own relevance test ("would this make Tola's thinking sharper")
    // is the real quality gate; this pre-filter just removes clearly off-topic
    // articles (scored 0) so we don't waste LLM context on them.
    .filter(a => a.relevanceScore >= 1)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const top = scored.slice(0, ARTICLE_CAP);
  console.log(`[TL Phase 2] After dedup + thesis-filter: ${deduped.length} unique → ${top.length} selected (cap ${ARTICLE_CAP}, score threshold >= 3)`);
  return top;
}

// ─── PHASE 4: SYNTHESIZE (own prompt, own relevance test) ────────────────────

function loadVaultContext() {
  // Reads from the SEPARATE thought-leadership vault subfolder only —
  // never the commercial daily vault.
  const vaultDir = path.join(__dirname, '../../vault/thought-leadership');
  try {
    if (!fs.existsSync(vaultDir)) return [];
    return fs.readdirSync(vaultDir)
      .filter(f => f.startsWith('TL_') && f.endsWith('.json'))
      .sort().reverse().slice(0, 4) // last ~month of weekly briefs
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(vaultDir, f), 'utf-8'));
          return { week: f.replace('TL_', '').replace('.json', ''), brief: d.brief };
        } catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}

function formatArticlesForSynthesis(articles) {
  return articles.map((a, i) => {
    const raw = a.content || a.description || '';
    const cleaned = cleanContent(raw).trim();
    const hasBody = cleaned.length > 200;
    const bodyText = hasBody ? cleaned.substring(0, 2000) : (cleaned.substring(0, 300) || a.title || '');
    const quality = hasBody ? 'FULL TEXT' : 'HEADLINE/SNIPPET ONLY — treat inferences as speculative';
    const dateStr = a.publishedAt ? new Date(a.publishedAt).toISOString().substring(0, 10) : 'date unknown';

    return `[${i}] SOURCE: ${a.source || 'Unknown'} | DATE: ${dateStr}
  Headline: ${a.title}
  Content quality: ${quality}
  Body: ${bodyText}
  URL: ${a.url || ''}`;
  }).join('\n\n');
}

function weekOfLabel() {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() - now.getUTCDay() + 1); // Monday
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = d => d.toISOString().substring(0, 10);
  return `${fmt(start)} to ${fmt(end)}`;
}

/**
 * Thought Leadership system prompt — full text per
 * Tola_Edge_Brief_Thought_Leadership_Track.md. {{scope}} substituted exactly
 * as specified. This prompt is intentionally NOT shared with, derived from,
 * or cross-referenced against buildSynthesisPrompt() in engine.js — no
 * Mixta P&L relevance language appears anywhere below.
 */
function buildThoughtLeadershipPrompt(articles, vaultContext) {
  const vaultSummary = vaultContext.length > 0
    ? 'PRIOR WEEKS\' THINKING (for continuity, not repetition):\n' +
      vaultContext.map(v => `[Week of ${v.week}] ${(v.brief?.synthesis || '').substring(0, 400)}...`).join('\n\n')
    : 'No prior weekly briefs (first run).';

  const scopeInstruction = SCOPE === 'Global'
    ? 'If GLOBAL: search Nigeria, Senegal, other African markets (Kenya, Ghana, South Africa, Rwanda are good starting points for comparative models), and at least one mature market (US, UK) for comparative housing finance innovation. Tola is explicitly interested in cross-market models he can adapt or reference — do not limit to Africa if GLOBAL is selected.'
    : 'If LOCAL: search Nigeria and Senegal only.';

  return `You are the Thought Leadership Track of The Tola Edge Brief — a weekly research brief for Tola Akinsulire, built to support his thought leadership platform on housing finance systems for the working and emerging middle class.

THIS IS NOT A COMMERCIAL INTELLIGENCE BRIEF. Do not apply Mixta P&L relevance tests. A story can be fully included here even if it has zero connection to Mixta Africa's commercial pipeline. The test for inclusion is entirely different — see RELEVANCE TEST below.

═══════════════════════════════════════
TOLA'S THOUGHT LEADERSHIP FOCUS
═══════════════════════════════════════
Lane: Housing finance systems for the working and emerging middle class — not only salaried 8-5 staff, but gig workers, freelancers, and creators whose income is real but doesn't fit traditional mortgage underwriting models.

Audience he has in mind:
- Salaried workers (teachers, nurses, civil servants, bank/corporate staff)
- Gig workers, freelancers, and creators with irregular but genuine income
- Households that are productive and upwardly mobile but financially fragile

Problems he cares about:
- Traditional mortgage models excluding people whose income patterns don't fit old templates
- The gap between policy/institutional design and real household outcomes
- Housing costs pushing working households backwards instead of supporting stability and productivity

═══════════════════════════════════════
THE FOUR PILLARS (organize findings under these)
═══════════════════════════════════════
1. SYSTEM DESIGN & POLICY — what a functional housing finance system for this segment should look like; how policy and regulation are (or aren't) adapting to new forms of work and income
2. CAPITAL & INSTRUMENTS — how capital (MREIF-type vehicles, pension funds, DFIs, banks) is being structured for this segment; practical instruments: guarantees, rent-to-own, shared equity, employer-backed support, hybrid products
3. DELIVERY & PARTNERSHIPS — how developers, lenders, employers, platforms, and government are partnering around this segment; institutional offtake, PPP-style structures, employer-backed housing models
4. HOUSEHOLD OUTCOMES & MEASUREMENT — evidence connecting housing stability to workforce productivity and household financial health; what "success" looks like beyond mortgage count

═══════════════════════════════════════
MARKET SCOPE: ${SCOPE}
═══════════════════════════════════════
${scopeInstruction}

═══════════════════════════════════════
RELEVANCE TEST (different from the commercial brief — read carefully)
═══════════════════════════════════════
Include a story if it does ONE OR MORE of the following:
- Illustrates a real model, pilot, or instrument serving non-traditional-income households (rent-to-own, shared equity, employer-backed housing, alternative underwriting, etc.)
- Provides a concrete data point about housing exclusion or housing stability's effect on productivity/financial health
- Shows a policy or regulatory shift (anywhere) relevant to how housing finance treats irregular income
- Demonstrates an institutional partnership model (DFI, pension fund, employer, platform) that could be referenced or adapted

Do NOT apply Mixta commercial relevance. A story does not need to connect to Mixta's pipeline, land, or capital position to qualify here. The only test is: would this make Tola's thinking sharper, or give him a concrete example worth writing or speaking about under one of the four pillars?

Be selective. Not every housing story qualifies — a story about general real estate price trends with no connection to financing models, income type, or household outcomes does not belong here. This track is intentionally narrow in subject (financing systems for non-traditional income) even when wide in geography.

═══════════════════════════════════════
STORY DEPTH REQUIREMENT
═══════════════════════════════════════
For each story, in addition to the factual summary, include:
- "Why this matters for your thesis" — one sentence connecting it explicitly to one of the four pillars
- "Possible angle" — a one-line suggestion for how this could become a LinkedIn post, article, or talking point, if applicable. If a story is reference material only (data point, not a publishable angle on its own), say so rather than forcing an angle.

═══════════════════════════════════════
CITATION REQUIREMENT
═══════════════════════════════════════
Cite inline by naming the source directly in the sentence (e.g. "according to a 2026 Centre for Affordable Housing Finance in Africa report"). No bracketed numeric citations without a resolved source key.

${vaultSummary}

═══════════════════════════════════════
THIS WEEK'S REAL SCRAPED ARTICLES
═══════════════════════════════════════
${formatArticlesForSynthesis(articles)}

═══════════════════════════════════════
HALLUCINATION GUARD
═══════════════════════════════════════
Every finding must cite real article content from the sources above. Do not invent facts not present in the articles.

═══════════════════════════════════════
OUTPUT FORMAT — RETURN ONLY VALID JSON, NO MARKDOWN, NO PREAMBLE
═══════════════════════════════════════
{
  "week_of": "${weekOfLabel()}",
  "scope": "${SCOPE}",
  "synthesis": "3-paragraph synthesis. P1: the most significant finding this week across all four pillars. P2: how this week's findings connect to or extend prior weeks' thinking (if vault context provided). P3: a suggested focus or question for Tola to explore further.",
  "findings": [
    {
      "title": "headline",
      "pillar": "one of: System Design & Policy | Capital & Instruments | Delivery & Partnerships | Household Outcomes & Measurement",
      "market": "country or market",
      "body": "2-3 sentence factual summary with inline named source citation",
      "thesis_relevance": "why this matters for the thesis, tied to the specific pillar",
      "possible_angle": "one-line content angle, or 'Reference material only' if not directly publishable",
      "sources": [0, 1]
    }
  ]
}

Target 4-6 findings per week. Quality over volume — this track favors depth and selectivity over comprehensive coverage.`;
}

function parseBrief(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON found');
    return JSON.parse(m[0]);
  } catch (e) {
    console.error('[TL Synthesis] Parse failed:', e.message);
    return null;
  }
}

const VALID_PILLARS = PILLARS;

function validateBrief(brief, articles) {
  if (!brief?.synthesis || !Array.isArray(brief.findings) || !brief.findings.length) return null;

  const valid = [];
  for (const finding of brief.findings) {
    if (!finding.title || !finding.body || !finding.thesis_relevance) continue;

    if (!VALID_PILLARS.includes(finding.pillar)) {
      const match = VALID_PILLARS.find(p =>
        p.toLowerCase().includes((finding.pillar || '').toLowerCase().split(' ')[0]));
      if (match) finding.pillar = match;
      else { console.warn(`[TL Validate] Dropping finding — invalid pillar: "${finding.pillar}"`); continue; }
    }

    if (!finding.possible_angle) finding.possible_angle = 'Reference material only';

    const rawSources = Array.isArray(finding.sources) ? finding.sources : [];
    const validIdx = rawSources.filter(i => Number.isInteger(i) && i >= 0 && i < articles.length);
    finding.sources = validIdx;
    finding.sourceArticles = validIdx.map(i => articles[i]).filter(Boolean)
      .map(a => ({ title: a.title, url: a.url, source: a.source }));

    valid.push(finding);
  }

  // Cap at 6 per spec ("Target 4-6 findings per week")
  brief.findings = valid.slice(0, 6);

  return brief.findings.length > 0 ? brief : null;
}

async function synthesizeThoughtLeadershipBrief(articles, vaultContext) {
  console.log('[TL Phase 4] Synthesizing weekly thought leadership brief...');
  console.log('[TL Phase 4] Cooling down 15s before synthesis...');
  await sleep(15000);

  const prompt = buildThoughtLeadershipPrompt(articles, vaultContext);
  const maxAttempts = 3;
  const SYNTHESIS_MAX_TOKENS = 6000; // same raised budget as the commercial
                                      // track's synthesis step — this prompt
                                      // is also long and deep, same risk of
                                      // truncation applies.

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[TL Phase 4] Synthesis attempt ${attempt}/${maxAttempts} (max_tokens=${SYNTHESIS_MAX_TOKENS})...`);
      const raw = await runChain(synthesisProviders(prompt, SYNTHESIS_MAX_TOKENS), `TL Synthesis attempt ${attempt}`);
      const parsed = parseBrief(raw);
      const validated = validateBrief(parsed, articles);
      if (validated) {
        console.log(`[TL Phase 4] Brief validated: ${validated.findings.length} findings`);
        return validated;
      }
      console.warn(`[TL Phase 4] Attempt ${attempt}: validation failed`);
    } catch (e) {
      console.warn(`[TL Phase 4] Attempt ${attempt} failed: ${e.message}`);
      if (attempt < maxAttempts) await sleep(8000);
    }
  }
  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOLA EDGE BRIEF — Thought Leadership Engine`);
  console.log(`Request: ${REQUEST_ID} | Scope: ${SCOPE}`);
  console.log(`${'='.repeat(60)}\n`);

  const vaultContext = loadVaultContext();
  console.log(`TL Vault: ${vaultContext.length} prior weekly brief(s) loaded for context\n`);

  const rawArticles = await fetchAllArticles();
  const filteredArticles = filterAndRankArticles(rawArticles);

  if (filteredArticles.length === 0) {
    throw new Error('No thesis-relevant articles found — check GNEWS_API_KEY and NEWSAPI_KEY secrets, or scope may be too narrow this week');
  }

  const enrichedArticles = await enrichArticles(filteredArticles);
  const brief = await synthesizeThoughtLeadershipBrief(enrichedArticles, vaultContext);

  const output = {
    request_id:   REQUEST_ID,
    status:       brief ? 'success' : 'error',
    brief:        brief,
    error:        brief ? null : 'Synthesis failed after all retries',
    generated_at: new Date().toISOString(),
    meta: {
      scope:              SCOPE,
      articles_fetched:   rawArticles.length,
      articles_considered: enrichedArticles.length,
      vault_entries_used: vaultContext.length,
      track:              'thought-leadership',
    },
  };

  // Separate output file from the commercial engine's /tmp/brief_output.json —
  // the workflow step that follows is responsible for copying this to
  // vault/thought-leadership/, never to the commercial vault/ path.
  fs.writeFileSync('/tmp/tl_brief_output.json', JSON.stringify(output, null, 2));
  console.log(`\n[TL Engine] Done — status: ${output.status} | articles: ${rawArticles.length} → ${enrichedArticles.length} → ${brief?.findings?.length ?? 0} findings`);

  if (!brief) process.exit(1);
}

main().catch(err => {
  console.error('[TL Engine] Fatal:', err.message);
  fs.writeFileSync('/tmp/tl_brief_output.json', JSON.stringify({
    request_id: REQUEST_ID, status: 'error', brief: null,
    error: err.message, generated_at: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
