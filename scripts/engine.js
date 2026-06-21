/**
 * Tola Edge Brief — Commercial Intelligence Engine v2.1
 * Runs inside GitHub Actions (Node 20 + ubuntu-latest). Never runs in the browser.
 *
 * This is the DAILY commercial brief for Tola Akinsulire, GCCO at Mixta Africa.
 * Every story in this brief must pass the Mixta P&L relevance test (see
 * buildSynthesisPrompt below). This engine does NOT power the weekly
 * Thought Leadership track — that is a fully separate file
 * (thought-leadership-engine.js) with its own prompt and relevance test,
 * by design. Do not blend the two. See that file's header comment for why.
 *
 * v2.1 changes (per Tola_Edge_Brief_System_Prompt_v2.md):
 *   - buildSynthesisPrompt fully replaced: relevance discipline with PASS/FAIL
 *     examples, impact-rating discipline, per-domain search requirement,
 *     named-inline citations (no more [0][1][2] markers), new watch_next
 *     field per story, new domain_coverage_notes array.
 *   - buildQueries() restructured to be domain-keyed: every active domain
 *     gets 2+ dedicated search queries, instead of one generic market-wide
 *     query list. (Previously the market toggle barely changed query
 *     content — this was a known bug, now fixed.)
 *   - Article cap raised 15 → 28 to give 6 domains x 2+ queries room to
 *     surface real per-domain volume; the v2 prompt's relevance discipline
 *     is what does the cutting down to 5-8 stories, not an early cap.
 *   - Synthesis max_tokens raised 2500 → 6000 (v2 targets deeper, more
 *     numerous stories than v1's 4-6 ceiling; 2500 risked truncation).
 *
 * Five-phase pipeline:
 *   Phase 1 — Fetch:    GNews + NewsAPI + Google News RSS + curated RSS feeds,
 *                        run per-domain (2+ queries/domain) not market-wide
 *   Phase 2 — Filter:   Dedupe + domain keyword scoring + cap to 28 articles
 *   Phase 3 — Enrich:   Puppeteer full-text extraction (shared lib)
 *   Phase 4 — Analyze:  6-LLM fallback chain per article (Groq 8b tier)
 *   Phase 5 — Synthesize: Groq 70b tier → v2 brief JSON schema (6000 tokens)
 *   Output  — Write /tmp/brief_output.json → workflow commits to main's data/
 *
 * GitHub Secrets consumed:
 *   GNEWS_API_KEY, NEWSAPI_KEY,
 *   GROQ_API_KEY, SAMBANOVA_API_KEY, CEREBRAS_API_KEY,
 *   MISTRAL_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { sleep, runChain, articleProviders, synthesisProviders } = require('./lib/providers');
const { fetchGNews, fetchNewsAPI, fetchGoogleNewsRSS, fetchRSSFeed, cleanContent, runFetchesInBatches } = require('./lib/fetchers');
const { enrichArticles } = require('./lib/enrichment');

// ─── ENV ─────────────────────────────────────────────────────────────────────

const REQUEST_ID     = process.env.REQUEST_ID     || String(Date.now());
const ACTIVE_MARKET  = process.env.ACTIVE_MARKET  || 'All';
const ACTIVE_DOMAINS = (process.env.ACTIVE_DOMAINS || 'D1,D2,D3,D4,D5,D6').split(',').map(d => d.trim());
const CUSTOM_PROMPT  = process.env.CUSTOM_PROMPT  || '';

// ─── DOMAIN DEFINITIONS ──────────────────────────────────────────────────────

const DOMAIN_MAP = {
  D1: 'Capital & Financing Architecture',
  D2: 'Land & Regulatory Alpha',
  D3: 'Demand-Side Market Intelligence',
  D4: 'Partnership & JV Origination Signals',
  D5: 'Geopolitical & Country Risk',
  D6: 'Market Creation Signals',
};

const DOMAIN_KEYWORDS = {
  D1: ['CBN', 'interest rate', 'mortgage', 'MREIF', 'NHF', 'FMBN', 'DFI', 'EBRD', 'IFC', 'AfDB',
       'BOI', 'financing', 'FX', 'naira', 'forex', 'construction cost', 'MOFI', 'housing finance',
       'BCEAO', 'bond', 'capital market', 'loan', 'credit'],
  D2: ['land use', "Governor's Consent", 'title', 'masterplan', 'zoning', 'layout approval',
       'infrastructure budget', 'planning', 'foncier', 'cadastre', 'land reform', 'property rights',
       'urban development', 'building permit', 'right of way'],
  D3: ['affordability', 'diaspora', 'remittance', 'housing demand', 'urbanisation', 'rent',
       'homeownership', 'absorption rate', 'competitor', 'pricing', 'demographics', 'migration',
       'corporate housing', 'employer housing'],
  D4: ['joint venture', 'JV', 'partnership', 'sovereign wealth', 'PPP', 'tender', 'fund',
       'divestiture', 'acquisition', 'disposal', 'mandate', 'allocation', 'investment'],
  D5: ['security', 'currency crisis', 'political', 'civil unrest', 'capital flight', 'sovereign',
       'credit rating', 'sanctions', 'conflict', 'instability', 'coup'],
  D6: ['informal sector', 'fintech', 'OPay', 'Moniepoint', 'PalmPay', 'cooperative',
       'formalization', 'affordable housing', 'social housing', 'mass market', 'low income',
       'NHF', 'Renewed Hope', 'One Million Homes', 'housing inclusion', 'financial inclusion'],
};

// Per-domain query templates. Each domain gets 2+ Nigeria queries and,
// when Senegal is in scope, 1+ French-language Senegal query — per the v2
// spec's explicit instruction to search EACH domain separately rather than
// running one general market-wide search and distributing results.
const DOMAIN_QUERIES_NG = {
  D1: ['CBN interest rate mortgage Nigeria 2026', 'MREIF MOFI housing finance Nigeria', 'DFI EBRD IFC AfDB housing Nigeria'],
  D2: ['Lagos land use Governor Consent title reform', 'Lekki Ibeju-Lekki masterplan zoning approval'],
  D3: ['Nigeria diaspora remittance real estate demand', 'Lagos housing affordability rent homeownership'],
  D4: ['Nigeria real estate joint venture partnership 2026', 'sovereign wealth fund Nigeria housing investment'],
  D5: ['Nigeria currency naira political risk 2026', 'Nigeria sovereign credit rating instability'],
  D6: ['Nigeria informal sector fintech Moniepoint OPay housing', 'Nigeria affordable housing FMBN Renewed Hope mass market'],
};

const DOMAIN_QUERIES_SN = {
  D1: ['BCEAO taux immobilier financement logement Sénégal', 'Sénégal banque crédit hypothécaire 2026'],
  D2: ['Sénégal foncier cadastre réforme terrain Dakar', 'Sénégal permis construire urbanisme plan'],
  D3: ['Sénégal demande logement abordable diaspora', 'Sénégal Dakar marché immobilier prix loyer'],
  D4: ['Sénégal partenariat immobilier investissement 2026', 'Sénégal fonds souverain FONSIS logement'],
  D5: ['Sénégal risque politique devise instabilité', 'Sénégal notation crédit souverain 2026'],
  D6: ['Sénégal secteur informel logement social inclusion financière', 'Sénégal microfinance habitat coopérative'],
};

/**
 * Domain-keyed query builder. Returns an array of { domain, query } pairs —
 * NOT a flat list — so Phase 1 can fetch per-domain and Phase 2 can verify
 * every active domain actually got searched (feeds domain_coverage_notes).
 */
function buildDomainQueries() {
  const includeNigeria = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Nigeria';
  const includeSenegal = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Senegal';

  const pairs = [];
  for (const domain of ACTIVE_DOMAINS) {
    if (!DOMAIN_MAP[domain]) continue;

    if (includeNigeria) {
      (DOMAIN_QUERIES_NG[domain] || []).forEach(q => pairs.push({ domain, query: q }));
    }
    if (includeSenegal) {
      (DOMAIN_QUERIES_SN[domain] || []).forEach(q => pairs.push({ domain, query: q }));
    }
  }

  // Custom prompt is appended as an additional targeted query against every
  // active domain so it can't accidentally only hit one domain's results.
  if (CUSTOM_PROMPT) {
    for (const domain of ACTIVE_DOMAINS) {
      if (!DOMAIN_MAP[domain]) continue;
      pairs.push({ domain, query: CUSTOM_PROMPT });
    }
  }

  return pairs;
}

const NIGERIA_RSS_FEEDS = [
  'https://businessday.ng/feed/',
  'https://www.thisdaylive.com/index.php/feed/',
  'https://thecable.ng/feed',
  'https://punchng.com/feed/',
  'https://guardian.ng/feed/',
  'https://nairametrics.com/feed/',
];

const SENEGAL_RSS_FEEDS = [
  'https://www.lesoleil.sn/feed/',
  'https://www.dakaractu.com/rss.xml',
  'https://apanews.net/feed/',
];

// ─── PHASE 1: FETCH (domain-keyed) ───────────────────────────────────────────

async function fetchAllArticles() {
  console.log('[Phase 1] Fetching articles — per-domain search (v2)...');
  const domainQueries = buildDomainQueries();
  const includeNigeria = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Nigeria';
  const includeSenegal = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Senegal';

  console.log(`[Phase 1] ${domainQueries.length} domain-tagged queries across ${ACTIVE_DOMAINS.length} active domain(s)`);
  ACTIVE_DOMAINS.forEach(d => {
    const count = domainQueries.filter(p => p.domain === d).length;
    console.log(`  ${d} (${DOMAIN_MAP[d] || 'unknown'}): ${count} quer${count === 1 ? 'y' : 'ies'}`);
  });

  // Tag every fetched article with the domain its query targeted, so Phase 2
  // can confirm coverage per domain even before LLM scoring runs.
  const taggedFetches = domainQueries.map(({ domain, query }) => {
    const isSenegalQuery = (DOMAIN_QUERIES_SN[domain] || []).includes(query);
    const gnewsOpts = isSenegalQuery ? { country: 'sn', lang: 'fr' } : { country: 'ng', lang: 'en' };
    const rssOpts = isSenegalQuery ? { hl: 'fr', gl: 'SN', ceid: 'SN:fr' } : { hl: 'en-NG', gl: 'NG', ceid: 'NG:en' };

    return Promise.all([
      fetchGNews(query, gnewsOpts),
      fetchNewsAPI(query),
      fetchGoogleNewsRSS(query, rssOpts),
    ]).then(([a, b, c]) => [...a, ...b, ...c].map(article => ({ ...article, _queryDomain: domain })));
  });

  const directFeedFetches = [
    ...(includeNigeria ? NIGERIA_RSS_FEEDS.map(f => fetchRSSFeed(f).then(arts => arts.map(a => ({ ...a, _queryDomain: null })))) : []),
    ...(includeSenegal ? SENEGAL_RSS_FEEDS.map(f => fetchRSSFeed(f).then(arts => arts.map(a => ({ ...a, _queryDomain: null })))) : []),
  ];

  const allFetches = [...taggedFetches, ...directFeedFetches];
  const results = await runFetchesInBatches(allFetches, 8, 500);

  console.log(`[Phase 1] Raw articles fetched: ${results.length}`);
  return results;
}

// ─── PHASE 2: FILTER & RELEVANCE ─────────────────────────────────────────────

const ARTICLE_CAP = 28; // raised from 15 — domain-keyed search surfaces more
                         // raw volume; v2 synthesis prompt's relevance
                         // discipline does the real cutting, not this cap.

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

function scoreRelevance(article) {
  const text = `${article.title} ${article.description} ${article.content}`.toLowerCase();
  let score = 0;

  const coreSignals = [
    'nigeria', 'lagos', 'abuja', 'lekki', 'ibeju', 'real estate', 'housing', 'property',
    'mortgage', 'development', 'construction', 'land', 'apartment', 'estate', 'mixta',
    'affordable', 'residential', 'commercial property', 'senegal', 'dakar', 'sénégal',
    'immobilier', 'logement',
  ];

  // If the article came from a domain-tagged query, give that domain's
  // keywords extra weight — it's a strong signal the search was on-target.
  const taggedDomainKeywords = article._queryDomain ? (DOMAIN_KEYWORDS[article._queryDomain] || []) : [];
  const activeDomainKeywords = ACTIVE_DOMAINS.flatMap(d => DOMAIN_KEYWORDS[d] || []);

  coreSignals.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 2; });
  activeDomainKeywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 3; });
  taggedDomainKeywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 2; }); // bonus

  // If it came from a domain-tagged query at all, small base bonus —
  // these were deliberately searched for, not incidentally caught.
  if (article._queryDomain) score += 2;

  const excludeGeo = ['uk ', 'usa ', 'india ', 'china ', 'europe ', 'australia ', 'canada '];
  excludeGeo.forEach(g => { if (text.includes(g)) score -= 2; });

  ['morocco', 'tunisia', "côte d'ivoire", 'ivory coast'].forEach(m => {
    if (text.includes(m)) score -= 5;
  });

  return score;
}

function filterAndRankArticles(articles) {
  const deduped = deduplicateArticles(articles);
  const scored = deduped
    .map(a => ({ ...a, relevanceScore: scoreRelevance(a) }))
    .filter(a => a.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const top = scored.slice(0, ARTICLE_CAP);
  console.log(`[Phase 2] After dedup + filter: ${deduped.length} unique → ${top.length} selected (cap ${ARTICLE_CAP}, score threshold > 0)`);

  // Per-domain coverage check at the fetch level — used as a fallback signal
  // for domain_coverage_notes if the LLM synthesis step doesn't explicitly
  // call out an empty domain.
  const domainsCovered = new Set(top.map(a => a._queryDomain).filter(Boolean));
  ACTIVE_DOMAINS.forEach(d => {
    if (!domainsCovered.has(d)) {
      console.log(`[Phase 2] ⚠ ${DOMAIN_MAP[d] || d}: no surviving articles after filter/cap`);
    }
  });

  return top;
}

// ─── PHASE 4: ANALYZE ─────────────────────────────────────────────────────────

function buildAnalysisPrompt(article, mixtaContext) {
  const title   = (article.title   || '').trim() || 'Untitled';
  const source  = (article.source  || '').trim() || 'Unknown';
  const url     = (article.url     || '').trim() || '';
  const content = (article.content || article.description || article.title || '').trim().substring(0, 1000);

  const activeProjects = (mixtaContext?.active_projects || []).map(p => p.name).join(', ');
  const competitors    = (mixtaContext?.competitors || []).map(c => c.name).slice(0, 10).join(', ');
  const priorities     = (mixtaContext?.company?.strategic_priorities_2026 || []).join('; ');
  const activeDomainNames = ACTIVE_DOMAINS.map(d => DOMAIN_MAP[d]).filter(Boolean).join(', ');

  return `You are a professional real estate analyst for Mixta Africa (Lagos-based developer, Ibeju-Lekki corridor).
Analyze this article with intellectual rigor. Active intelligence domains: ${activeDomainNames}.

COMPANY CONTEXT:
- Strategic Priorities: ${priorities}
- Active Projects: ${activeProjects}
- Key Competitors: ${competitors}

ARTICLE:
Title: ${title}
Source: ${source}
URL: ${url}
Content: ${content}

Respond ONLY in this JSON format (no markdown, no preamble):
{
  "summary": "Professional 2-3 sentence analyst summary of what this means for Lagos real estate",
  "sentiment": "bullish|bearish|neutral",
  "domain": "One of: ${ACTIVE_DOMAINS.map(d => DOMAIN_MAP[d]).filter(Boolean).join(' | ')}",
  "market": "Nigeria|Senegal",
  "location_tags": "Lagos,Lekki,etc",
  "trending_topics": "comma,separated,tags",
  "market_impact_severity": "critical|high|medium|low|negligible",
  "affected_segments": "affordable housing,mid-market,premium,commercial",
  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",
  "mixta_relevance": {
    "direct_impact": "Description or None",
    "indirect_impact": "Description or None",
    "strategic_opportunity": "Description or None",
    "risk_flag": "Description or None"
  }
}`;
}

function parseAnalysis(text) {
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}

async function analyzeArticles(articles, mixtaContext) {
  console.log(`[Phase 4] Analyzing ${articles.length} articles via 6-LLM chain...`);
  const results = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`[Phase 4] Article ${i+1}/${articles.length}: "${article.title.substring(0,60)}"`);
    const prompt = buildAnalysisPrompt(article, mixtaContext);
    try {
      // Per-article analysis stays on the small token budget (default 1000) —
      // only synthesis gets the raised budget. articleProviders' default
      // param handles this; we don't pass a maxTokens override here.
      const raw = await runChain(articleProviders(prompt), `Article ${i+1}`);
      const analysis = parseAnalysis(raw);
      results.push({ ...article, ...analysis, _analyzed: true });
    } catch (e) {
      console.warn(`[Phase 4] Analysis failed for article ${i+1}: ${e.message}`);
      results.push({ ...article, _analyzed: false, market_impact_severity: 'low' });
    }
    if (i < articles.length - 1) await sleep(500);
  }
  console.log(`[Phase 4] Analysis complete: ${results.filter(a => a._analyzed).length}/${articles.length} succeeded`);
  return results;
}

// ─── PHASE 5: SYNTHESIZE (v2 prompt) ─────────────────────────────────────────

function loadMixtaContext() {
  const p = path.join(__dirname, '../../data/mixta-context.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { console.warn('[Engine] mixta-context.json not loaded:', e.message); return null; }
}

function loadVaultContext() {
  const vaultDir = path.join(__dirname, '../../vault');
  try {
    if (!fs.existsSync(vaultDir)) return [];
    return fs.readdirSync(vaultDir)
      .filter(f => f.startsWith('TEB_') && f.endsWith('.json'))
      .sort().reverse().slice(0, 3)
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(vaultDir, f), 'utf-8'));
          return { date: f.replace('TEB_','').replace('.json',''), brief: d.brief };
        } catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}

function formatArticlesForSynthesis(articles) {
  return articles.map((a, i) => {
    const raw = a.content || a.description || '';
    const cleaned = cleanContent(raw).trim();
    const hasBody = cleaned.length > 200;

    let bodyText;
    if (hasBody) {
      bodyText = cleaned.substring(0, 2000);
    } else if (a.summary && !a.summary.startsWith('Unable')) {
      bodyText = a.summary;
    } else {
      bodyText = cleaned.substring(0, 300) || a.title || '';
    }

    const quality = hasBody ? 'FULL TEXT'
      : (a.summary && !a.summary.startsWith('Unable')) ? 'AI SUMMARY ONLY'
      : 'HEADLINE ONLY — treat all inferences as speculative';

    // Index, source name and date included so the model can satisfy the
    // named-inline citation requirement without bracketed [index] markers.
    const dateStr = a.publishedAt ? new Date(a.publishedAt).toISOString().substring(0, 10) : 'date unknown';

    return `[${i}] SOURCE: ${a.source || 'Unknown'} | DATE: ${dateStr} | DOMAIN SEARCHED: ${a._queryDomain ? (DOMAIN_MAP[a._queryDomain] || a._queryDomain) : 'general'}
  Headline: ${a.title}
  Content quality: ${quality}
  Sentiment: ${a.sentiment || 'neutral'} | Severity: ${a.market_impact_severity || 'n/a'}
  Body: ${bodyText}
  URL: ${a.url || ''}`;
  }).join('\n\n');
}

/**
 * v2 system prompt — full replacement per Tola_Edge_Brief_System_Prompt_v2.md.
 * {{domains}} and {{market}} are substituted exactly as in v1; everything
 * else is new per the spec (relevance discipline, impact discipline,
 * per-domain search instruction, named-inline citations, watch_next,
 * domain_coverage_notes).
 */
function buildSynthesisPrompt(articles, mixtaContext, vaultContext) {
  const activeDomainNames = ACTIVE_DOMAINS.map(d => DOMAIN_MAP[d]).filter(Boolean).join(', ');
  const marketScope = ACTIVE_MARKET === 'All' ? 'Nigeria (primary) and Senegal (secondary)' : ACTIVE_MARKET;

  const priorities   = (mixtaContext?.company?.strategic_priorities_2026 || []).map(p => `- ${p}`).join('\n');
  const watchList    = (mixtaContext?.watch_list || []).map(w => `- ${w.topic}: ${w.why}`).join('\n');
  const activeProjects = (mixtaContext?.active_projects || [])
    .filter(p => (p.location || '').toLowerCase().includes('lagos') || (p.location || '').toLowerCase().includes('lekki'))
    .map(p => `- ${p.name}: ${p.segment}. Open issues: ${(p.open_issues || []).join(', ') || 'None'}`)
    .join('\n');

  const vaultSummary = vaultContext.length > 0
    ? 'PRIOR BRIEF CONTEXT (pattern recognition):\n' +
      vaultContext.map(v => `[${v.date}] ${(v.brief?.narrative || '').substring(0, 400)}...`).join('\n\n')
    : 'No prior briefs (first run).';

  const customSection = CUSTOM_PROMPT
    ? `\nTARGETED BRIEF REQUEST: "${CUSTOM_PROMPT}" — prioritise stories that directly address this.\n` : '';

  // Which active domains produced zero surviving articles at the fetch/filter
  // stage — passed to the model explicitly so it can corroborate (or correct,
  // if it found something via a feed article that wasn't domain-tagged) the
  // domain_coverage_notes it's required to produce.
  const domainsCovered = new Set(articles.map(a => a._queryDomain).filter(Boolean));
  const possiblyEmptyDomains = ACTIVE_DOMAINS
    .filter(d => DOMAIN_MAP[d] && !domainsCovered.has(d))
    .map(d => DOMAIN_MAP[d]);

  return `You are The Tola Edge Brief, a private intelligence system for Tola Akinsulire, GCCO at Mixta Africa (pan-African real estate developer, active markets: Nigeria and Senegal).

ACTIVE DOMAINS: ${activeDomainNames}
MARKET SCOPE: ${marketScope}

═══════════════════════════════════════
STRATEGIC CONTEXT (for relevance judgments)
═══════════════════════════════════════
- Mixta is a pan-African developer focused on Nigeria (primary) and Senegal (developing, secondary weight). Morocco, Tunisia, and Côte d'Ivoire are divested — do not monitor these markets.
- FlexHome: a cash-flow-based flexible mortgage product for non-traditional/informal sector earners. A Capital×Demand intersection play.
- Lagos New Town: flagship master-planned development.
- The overarching thesis: building homeownership infrastructure at the scale of Moniepoint's impact on payments — targeting Nigeria's informal majority (83% of employment), who have real income but no mortgage access.
- For Senegal: search and read French-language sources (BCEAO, government portals, Le Soleil, Jeune Afrique) — English-only scanning misses the most consequential Senegal signals.

ACTIVE PROJECTS (Lagos/Lekki corridor):
${activeProjects || 'None loaded'}

STRATEGIC PRIORITIES 2026:
${priorities || 'None loaded'}

WATCH LIST:
${watchList || 'None loaded'}
${customSection}
${vaultSummary}

═══════════════════════════════════════
DOMAIN PRIORITY ORDER (highest to lowest consequence)
═══════════════════════════════════════
1. Market Creation Signals — conditions validating/accelerating the mass-market homeownership thesis
2. Capital & Financing Architecture — DFI signals, MREIF, CBN/BOI rates, housing finance innovation
3. Land & Regulatory Alpha — policy signals with land positioning value
4. Demand-Side Intelligence and Partnership & JV Signals — equal weight
5. Geopolitical & Country Risk — THRESHOLD ALERT ONLY. Do not include unless something is genuinely alert-level today (currency shock, political transition, unrest affecting operations). Most days this domain should be empty.

═══════════════════════════════════════
SEARCH REQUIREMENT — DO NOT SKIP
═══════════════════════════════════════
The articles below were already gathered using domain-specific search queries (2+ queries per active domain), not one general search. The following domains returned NO domain-tagged articles after fetch/filter: ${possiblyEmptyDomains.length > 0 ? possiblyEmptyDomains.join(', ') : 'none — all active domains returned at least one candidate article'}.
- Raw signal volume in Nigerian/Senegalese real estate, policy, and financing news is high. A daily brief returning fewer than 4 stories from a 5-6 domain scope is very unlikely to reflect genuine signal scarcity — it more likely reflects insufficient search depth. Treat a thin result as a signal to search harder before finalizing, not as an acceptable outcome.
- Target 5-8 stories per brief when multiple domains are active. Quality discipline (below) determines which stories survive — consider all articles below broadly, then cut hard per the relevance test.

═══════════════════════════════════════
RELEVANCE DISCIPLINE — THE MOST IMPORTANT RULE
═══════════════════════════════════════
A "Mixta Relevance" section is not mandatory filler. It is a test each story must pass.

Before including any story, ask: does this story affect Mixta's mandate through a SINGLE, NAMED, SPECIFIC mechanism — not a general or aspirational one?

PASS examples:
- "Streamlines Governor's Consent → reduces title conversion timelines for Lagos New Town" (specific mechanism, specific project)
- "FMBN rate cut → lowers monthly repayment threshold → expands FlexHome's addressable informal-sector segment" (specific, traceable causal chain)

FAIL examples — DO NOT include stories like these, even if true and well-sourced:
- A financing deal in an unrelated sector (e.g. fertiliser, telecoms) included because "it's also a loan" or "could be a model for financing strategy" — too generic, discard
- A social/education/infrastructure story connected to housing only through a vague, multi-step inference (e.g. "better education outcomes could benefit families who may want homes") — discard
- Any story where the relevance section could be copy-pasted onto a different, unrelated story without changing its meaning — that's a sign the relevance is generic, not real. Discard.

If you cannot write a relevance sentence with a specific, named mechanism, the story does not belong in the brief. Cut it rather than force it. A shorter brief with only real connections is more valuable than a longer one with manufactured ones.

═══════════════════════════════════════
IMPACT RATING DISCIPLINE
═══════════════════════════════════════
Do not default to "Medium." Each rating must be earned:
- HIGH: direct, near-term, quantifiable effect on Mixta's pipeline, capital position, or land strategy (e.g. a rate change that immediately affects mortgage affordability for an active product; a title reform directly affecting a named Mixta project)
- MEDIUM: a real, specific connection per the relevance test above, but effect is indirect, delayed, or modest in scale
- LOW: worth noting for situational awareness, real connection exists, but minimal near-term action implication
A brief where every story is rated Medium has not done its job. Be willing to rate most stories Low, a few Medium, and reserve High for genuine standouts.

═══════════════════════════════════════
STORY DEPTH REQUIREMENT
═══════════════════════════════════════
Each story must include, beyond the factual summary:
- A "what to watch next" or forward-looking line — e.g. "Monitor closely — second reading passed with cross-party support" or "Awaiting BOI confirmation expected within 2 weeks"
- This is not optional flavor text. A story without a forward-looking element is incomplete.

═══════════════════════════════════════
CITATION REQUIREMENT
═══════════════════════════════════════
Do not use bracketed numeric citation markers like [0], [1], [2] in the narrative or story text unless a resolved source list with matching numbers is included beneath every section that uses them. Default approach: cite inline by naming the source directly in the sentence (e.g. "as reported by BusinessDay on 17 June 2026") rather than using numeric markers. Every factual claim must be traceable to a named, dated source within the same sentence or the sentence immediately following. Source names and dates are provided with each article below — use them.

═══════════════════════════════════════
DOMAIN COVERAGE STATEMENT (REQUIRED)
═══════════════════════════════════════
After the story list, include a short domain coverage line for every ACTIVE domain that produced zero qualifying stories today. Format: "{Domain name}: no material signals today." This makes the difference between "we checked and nothing moved" and "we forgot to check" visible to the reader. Do not include this line for domains that did produce stories.

═══════════════════════════════════════
TODAY'S REAL SCRAPED ARTICLES (gathered via domain-tagged search)
═══════════════════════════════════════
${formatArticlesForSynthesis(articles)}

═══════════════════════════════════════
HALLUCINATION GUARD
═══════════════════════════════════════
Every story must cite real article content from the sources above. Do not invent facts not present in the articles. Cite by naming the source and date inline (per CITATION REQUIREMENT) — do not use bracketed [index] markers in the narrative or story body/relevance/watch_next text. The "sources" array field (below) should still list the numeric indices of articles used, for internal validation — but that array is metadata, not a citation style to put in the prose.

═══════════════════════════════════════
OUTPUT FORMAT — RETURN ONLY VALID JSON, NO MARKDOWN, NO PREAMBLE
═══════════════════════════════════════
{
  "narrative": "4-paragraph executive prose. P1: top Nigeria signal. P2: financing or Senegal signal. P3: market creation/informal sector signal. P4: strategic synthesis for Mixta this week. Cite sources by name inline, never by bracketed number.",
  "stories": [
    {
      "title": "Factual headline, not editorialised",
      "domain": "Capital & Financing Architecture | Land & Regulatory Alpha | Demand-Side Market Intelligence | Partnership & JV Origination Signals | Geopolitical & Country Risk | Market Creation Signals",
      "market": "Nigeria or Senegal",
      "impact": "High or Medium or Low",
      "body": "2-3 sentence factual summary with inline named source citation, real figures from the source articles",
      "relevance": "Specific implication for Tola and Mixta via a named, traceable mechanism — must pass the relevance discipline test above",
      "watch_next": "Forward-looking line — what happens next and when",
      "sources": [0, 1]
    }
  ],
  "domain_coverage_notes": [
    "{Domain name}: no material signals today."
  ]
}

5-8 stories target when scope allows. Only include Geopolitical if genuinely alert-level. Every story must pass the relevance discipline test. All stories must be real, current, and individually sourced — never fabricated.`;
}

function parseBrief(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON found');
    return JSON.parse(m[0]);
  } catch (e) {
    console.error('[Synthesis] Parse failed:', e.message);
    return null;
  }
}

const VALID_DOMAINS = Object.values(DOMAIN_MAP);
const VALID_MARKETS = ['Nigeria', 'Senegal'];
const VALID_IMPACTS = ['High', 'Medium', 'Low'];

function validateBrief(brief, articles) {
  if (!brief?.narrative || !Array.isArray(brief.stories) || !brief.stories.length) return null;

  let invalidCitations = 0;
  const valid = [];

  for (const story of brief.stories) {
    // watch_next is now required per v2 — a story missing it is incomplete,
    // not a story we silently accept without it.
    if (!story.title || !story.body || !story.relevance || !story.watch_next) continue;

    if (!VALID_DOMAINS.includes(story.domain)) {
      const match = VALID_DOMAINS.find(d => d.toLowerCase().includes((story.domain || '').toLowerCase().split(' ')[0]));
      if (match) story.domain = match;
      else { console.warn(`[Validate] Dropping story — invalid domain: "${story.domain}"`); continue; }
    }
    if (!VALID_MARKETS.includes(story.market)) story.market = 'Nigeria';
    if (!VALID_IMPACTS.includes(story.impact)) story.impact = 'Low'; // v2: default to Low, not Medium —
                                                                       // matches impact-rating discipline intent

    const rawSources = Array.isArray(story.sources) ? story.sources : [];
    const validIdx = rawSources.filter(i => Number.isInteger(i) && i >= 0 && i < articles.length);
    invalidCitations += rawSources.length - validIdx.length;
    story.sources = validIdx;
    story.sourceArticles = validIdx.map(i => articles[i]).filter(Boolean)
      .map(a => ({ title: a.title, url: a.url, source: a.source }));

    if (validIdx.length < 2 && story.impact === 'High') story.impact = 'Medium';
    valid.push(story);
  }

  if (invalidCitations > 0) console.warn(`[Validate] Removed ${invalidCitations} invalid citations`);

  const order = { High: 0, Medium: 1, Low: 2 };
  valid.sort((a, b) => (order[a.impact] ?? 2) - (order[b.impact] ?? 2));
  // v2 targets 5-8 stories (was capped at 6) — raise the cap to 8
  brief.stories = valid.slice(0, 8);

  // domain_coverage_notes: trust the model's own list if it's a non-empty
  // array of strings; otherwise fall back to a generated list from the
  // fetch-stage domain coverage check, so the field is never silently absent.
  if (!Array.isArray(brief.domain_coverage_notes)) {
    brief.domain_coverage_notes = [];
  }
  brief.domain_coverage_notes = brief.domain_coverage_notes.filter(n => typeof n === 'string' && n.trim());

  if (brief.domain_coverage_notes.length === 0) {
    const coveredDomains = new Set(brief.stories.map(s => s.domain));
    ACTIVE_DOMAINS.forEach(d => {
      const name = DOMAIN_MAP[d];
      if (name && !coveredDomains.has(name)) {
        brief.domain_coverage_notes.push(`${name}: no material signals today.`);
      }
    });
  }

  return brief.stories.length > 0 ? brief : null;
}

async function synthesizeBrief(articles, mixtaContext, vaultContext) {
  console.log('[Phase 5] Synthesizing executive brief (v2 prompt)...');

  console.log('[Phase 5] Cooling down 20s before synthesis...');
  await sleep(20000);

  const prompt = buildSynthesisPrompt(articles, mixtaContext, vaultContext);
  const maxAttempts = 3;

  // v2: max_tokens raised 2500 → 6000. Passed explicitly to synthesisProviders
  // so it flows through every provider in the chain, not just groq70b.
  const SYNTHESIS_MAX_TOKENS = 6000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Phase 5] Synthesis attempt ${attempt}/${maxAttempts} (max_tokens=${SYNTHESIS_MAX_TOKENS})...`);
      const raw = await runChain(synthesisProviders(prompt, SYNTHESIS_MAX_TOKENS), `Synthesis attempt ${attempt}`);
      const parsed = parseBrief(raw);
      const validated = validateBrief(parsed, articles);
      if (validated) {
        console.log(`[Phase 5] Brief validated: ${validated.stories.length} stories, ${validated.domain_coverage_notes.length} coverage note(s)`);
        return validated;
      }
      console.warn(`[Phase 5] Attempt ${attempt}: validation failed`);
    } catch (e) {
      console.warn(`[Phase 5] Attempt ${attempt} failed: ${e.message}`);
      if (attempt < maxAttempts) await sleep(8000);
    }
  }
  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOLA EDGE BRIEF — Commercial Intelligence Engine v2.1`);
  console.log(`Request: ${REQUEST_ID} | Market: ${ACTIVE_MARKET} | Domains: ${ACTIVE_DOMAINS.join(',')}`);
  console.log(`${'='.repeat(60)}\n`);

  const mixtaContext = loadMixtaContext();
  const vaultContext = loadVaultContext();
  console.log(`Vault: ${vaultContext.length} prior brief(s) loaded for context\n`);

  const rawArticles = await fetchAllArticles();
  const filteredArticles = filterAndRankArticles(rawArticles);

  if (filteredArticles.length === 0) {
    throw new Error('No relevant articles found — check GNEWS_API_KEY and NEWSAPI_KEY secrets');
  }

  const enrichedArticles = await enrichArticles(filteredArticles);
  const analyzedArticles = await analyzeArticles(enrichedArticles, mixtaContext);
  const brief = await synthesizeBrief(analyzedArticles, mixtaContext, vaultContext);

  const output = {
    request_id:   REQUEST_ID,
    status:       brief ? 'success' : 'error',
    brief:        brief,
    error:        brief ? null : 'Synthesis failed after all retries',
    generated_at: new Date().toISOString(),
    meta: {
      market:             ACTIVE_MARKET,
      domains:            ACTIVE_DOMAINS,
      articles_fetched:   rawArticles.length,
      articles_analyzed:  analyzedArticles.length,
      vault_entries_used: vaultContext.length,
      custom_prompt:      CUSTOM_PROMPT || null,
      prompt_version:     'v2.1',
    },
  };

  fs.writeFileSync('/tmp/brief_output.json', JSON.stringify(output, null, 2));
  console.log(`\n[Engine] Done — status: ${output.status} | articles: ${rawArticles.length} → ${analyzedArticles.length} → ${brief?.stories?.length ?? 0} stories`);

  if (!brief) process.exit(1);
}

main().catch(err => {
  console.error('[Engine] Fatal:', err.message);
  fs.writeFileSync('/tmp/brief_output.json', JSON.stringify({
    request_id: REQUEST_ID, status: 'error', brief: null,
    error: err.message, generated_at: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
