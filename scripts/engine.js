/**
 * Tola Edge Brief — Intelligence Engine v2.0
 * Runs inside GitHub Actions (Node 20 + ubuntu-latest). Never runs in the browser.
 *
 * CORRECTED ARCHITECTURE (per Gemini review):
 *   Free-tier LLMs (Groq, Mistral, etc.) have NO live web access.
 *   This engine runs the REAL pipeline — scraping actual news sources —
 *   then feeds real article text to the 6-LLM chain for analysis and synthesis.
 *
 * Five-phase pipeline:
 *   Phase 1 — Fetch:    GNews + NewsAPI + Google News RSS + curated RSS feeds
 *   Phase 2 — Filter:   Dedupe + domain keyword scoring + cap to 15 articles
 *   Phase 3 — Enrich:   Puppeteer full-text extraction (v4.1 logic, isolated browsers)
 *   Phase 4 — Analyze:  6-LLM fallback chain per article (Groq 8b tier)
 *   Phase 5 — Synthesize: Groq 70b tier → strict brief JSON schema
 *   Output  — Write /tmp/brief_output.json → Actions pushes to gh-pages
 *
 * GitHub Secrets consumed:
 *   GNEWS_API_KEY, NEWSAPI_KEY,
 *   GROQ_API_KEY, SAMBANOVA_API_KEY, CEREBRAS_API_KEY,
 *   MISTRAL_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY
 */

'use strict';

const axios    = require('axios');
const cheerio  = require('cheerio');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

// ─── ENV ─────────────────────────────────────────────────────────────────────

const REQUEST_ID     = process.env.REQUEST_ID     || String(Date.now());
const ACTIVE_MARKET  = process.env.ACTIVE_MARKET  || 'All';
const ACTIVE_DOMAINS = (process.env.ACTIVE_DOMAINS || 'D1,D2,D3,D4,D5,D6').split(',').map(d => d.trim());
const CUSTOM_PROMPT  = process.env.CUSTOM_PROMPT  || '';

const GNEWS_KEY     = process.env.GNEWS_API_KEY  || '';
const NEWSAPI_KEY   = process.env.NEWSAPI_KEY    || '';

const TIMEOUT = 30000;

// ─── DOMAIN DEFINITIONS ──────────────────────────────────────────────────────

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

const DOMAIN_MAP = {
  D1: 'Capital & Financing Architecture',
  D2: 'Land & Regulatory Alpha',
  D3: 'Demand-Side Market Intelligence',
  D4: 'Partnership & JV Origination Signals',
  D5: 'Geopolitical & Country Risk',
  D6: 'Market Creation Signals',
};

// ─── SOURCE CONFIGURATION ────────────────────────────────────────────────────

function buildQueries() {
  const queries = [];
  const includeNigeria = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Nigeria';
  const includeSenegal = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Senegal';

  if (includeNigeria) {
    queries.push(
      'Nigeria real estate housing 2025',
      'Lagos property mortgage CBN 2025',
      'Lekki Ibeju-Lekki development infrastructure',
      'Nigeria affordable housing policy FMBN NHF',
      'Lagos New Town Lakowe property',
      'Nigeria diaspora real estate remittance',
      'CBN interest rate housing finance Nigeria',
      'MREIF MOFI mortgage Nigeria 2025',
      'Green Line Metro Lekki airport Lagos',
      'Dangote refinery Lekki corridor real estate',
    );
    if (CUSTOM_PROMPT) queries.push(CUSTOM_PROMPT + ' Nigeria');
  }

  if (includeSenegal) {
    // French-language queries for Senegal per brief spec
    queries.push(
      'immobilier Sénégal Dakar 2025',
      'logement abordable Sénégal politique',
      'BCEAO taux immobilier Afrique Ouest',
      'Sénégal infrastructure foncier cadastre',
      'Dakar projet immobilier développeur',
    );
    if (CUSTOM_PROMPT) queries.push(CUSTOM_PROMPT + ' Sénégal');
  }

  return queries;
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

// ─── PHASE 1: FETCH ──────────────────────────────────────────────────────────

async function fetchGNews(query) {
  if (!GNEWS_KEY) return [];
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&country=ng&max=10&apikey=${GNEWS_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
    return (res.data.articles || []).map(a => ({
      title: a.title, url: a.url, description: a.description,
      content: a.content, source: a.source?.name || 'GNews',
      publishedAt: a.publishedAt, fetchSource: 'gnews',
    }));
  } catch (e) {
    console.warn(`[GNews] Failed for "${query.substring(0,40)}": ${e.message}`);
    return [];
  }
}

async function fetchNewsAPI(query) {
  if (!NEWSAPI_KEY) return [];
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=10&apiKey=${NEWSAPI_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
    return (res.data.articles || []).filter(a => a.url !== '[Removed]').map(a => ({
      title: a.title, url: a.url, description: a.description,
      content: a.content, source: a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt, fetchSource: 'newsapi',
    }));
  } catch (e) {
    console.warn(`[NewsAPI] Failed for "${query.substring(0,40)}": ${e.message}`);
    return [];
  }
}

async function fetchGoogleNewsRSS(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-NG&gl=NG&ceid=NG:en`;
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const items = res.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 10).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
      const link  = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
      const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      return { title, url: link, description: desc.replace(/<[^>]+>/g, ''),
               content: '', source: 'Google News', publishedAt: pub, fetchSource: 'google-rss' };
    }).filter(a => a.title && a.url);
  } catch (e) {
    console.warn(`[GoogleRSS] Failed for "${query.substring(0,40)}": ${e.message}`);
    return [];
  }
}

async function fetchRSSFeed(feedUrl) {
  try {
    const res = await axios.get(feedUrl, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const items = res.data.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const sourceName = new URL(feedUrl).hostname.replace('www.', '');
    return items.slice(0, 8).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const link  = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                     item.match(/<description>(.*?)<\/description>/) || [])[1] || '';
      const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
      return { title: title.trim(), url: link.trim(),
               description: desc.replace(/<[^>]+>/g, '').trim(),
               content: '', source: sourceName, publishedAt: pub, fetchSource: 'rss' };
    }).filter(a => a.title && a.url);
  } catch (e) {
    console.warn(`[RSS] Failed ${feedUrl}: ${e.message}`);
    return [];
  }
}

async function fetchAllArticles() {
  console.log('[Phase 1] Fetching articles from all sources...');
  const queries = buildQueries();
  const includeNigeria = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Nigeria';
  const includeSenegal = ACTIVE_MARKET === 'All' || ACTIVE_MARKET === 'Senegal';

  const fetches = [
    // API sources for each query
    ...queries.map(q => fetchGNews(q)),
    ...queries.map(q => fetchNewsAPI(q)),
    ...queries.map(q => fetchGoogleNewsRSS(q)),
    // Direct RSS feeds
    ...(includeNigeria ? NIGERIA_RSS_FEEDS.map(f => fetchRSSFeed(f)) : []),
    ...(includeSenegal ? SENEGAL_RSS_FEEDS.map(f => fetchRSSFeed(f)) : []),
  ];

  // Run in parallel batches of 8 to avoid overwhelming APIs
  const results = [];
  for (let i = 0; i < fetches.length; i += 8) {
    const batch = await Promise.allSettled(fetches.slice(i, i + 8));
    batch.forEach(r => { if (r.status === 'fulfilled') results.push(...r.value); });
    if (i + 8 < fetches.length) await sleep(500);
  }

  console.log(`[Phase 1] Raw articles fetched: ${results.length}`);
  return results;
}

// ─── PHASE 2: FILTER & RELEVANCE ─────────────────────────────────────────────

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(a => {
    if (!a.title || !a.url) return false;
    const key = a.url.split('?')[0].toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    // Also dedupe by title similarity (first 60 chars)
    const titleKey = a.title.toLowerCase().substring(0, 60);
    if (seen.has(titleKey)) return false;
    seen.add(titleKey);
    return true;
  });
}

function scoreRelevance(article) {
  const text = `${article.title} ${article.description} ${article.content}`.toLowerCase();
  let score = 0;

  // Core real estate / Nigeria relevance signals
  const coreSignals = [
    'nigeria', 'lagos', 'abuja', 'lekki', 'ibeju', 'real estate', 'housing', 'property',
    'mortgage', 'development', 'construction', 'land', 'apartment', 'estate', 'mixta',
    'affordable', 'residential', 'commercial property', 'senegal', 'dakar', 'sénégal',
    'immobilier', 'logement',
  ];

  // Domain keyword scoring
  const activeDomainKeywords = ACTIVE_DOMAINS.flatMap(d => DOMAIN_KEYWORDS[d] || []);

  coreSignals.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 2; });
  activeDomainKeywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 3; });

  // Penalty for irrelevant geo
  const excludeGeo = ['uk ', 'usa ', 'india ', 'china ', 'europe ', 'australia ', 'canada '];
  excludeGeo.forEach(g => { if (text.includes(g)) score -= 2; });

  // Penalty for divested markets
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

  const top = scored.slice(0, 15);
  console.log(`[Phase 2] After dedup + filter: ${deduped.length} unique → ${top.length} selected (score threshold > 0)`);
  return top;
}

// ─── PHASE 3: ENRICH (content-enricher.js v4.1 logic) ───────────────────────

const THIN_THRESHOLD = 200;
const MAX_EXTRACT    = 3000;
const HARD_TIMEOUT   = 30000;
const PAGE_TIMEOUT   = 20000;
const BETWEEN_DELAY  = 1500;

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function usableLength(article) {
  return cleanContent(article.content || article.description || '').length;
}

// Axios-based HTML enricher — replaces Puppeteer.
// Fetches raw HTML, extracts article text with cheerio.
// Faster, zero install time, no Chromium needed.
async function attemptEnrich(article) {
  try {
    const response = await axios.get(article.url, {
      timeout: PAGE_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);

    // Remove noise elements
    $('script,style,nav,header,footer,aside,iframe,noscript,form,.ad,.sidebar,.comments,.cookie,.popup').remove();

    // Try article selectors in priority order
    let text = '';
    const selectors = ['article', '.entry-content', '.post-content', '.article-body', '.article-content', 'main', '#main'];
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length && el.text().trim().length > 200) {
        text = el.text().trim();
        break;
      }
    }

    // Fallback: collect all paragraphs
    if (!text) {
      const paras = [];
      $('p').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 20) paras.push(t);
      });
      text = paras.join(' ');
    }

    const cleanText = cleanContent(text).substring(0, MAX_EXTRACT);

    if (cleanText.length > 150) {
      console.log(`[Enricher] OK: ${cleanText.length} chars — "${article.title.substring(0,50)}"`);
      return { ...article, content: cleanText, resolvedUrl: article.url, contentEnriched: true };
    }
    console.log(`[Enricher] THIN: "${article.title.substring(0,50)}"`);
    return { ...article, contentEnriched: false };
  } catch (err) {
    console.error(`[Enricher] FAIL: "${article.title.substring(0,50)}" — ${err.message.split('\n')[0]}`);
    return { ...article, contentEnriched: false };
  }
}

function enrichWithTimeout(article) {
  return Promise.race([
    attemptEnrich(article),
    new Promise(resolve =>
      setTimeout(() => {
        console.error(`[Enricher] TIMEOUT: "${article.title.substring(0,50)}"`);
        resolve({ ...article, contentEnriched: false });
      }, HARD_TIMEOUT)
    ),
  ]);
}

async function enrichArticles(articles) {
  const thin    = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);
  console.log(`[Phase 3] ${already.length} OK, ${thin.length} need enrichment`);

  if (thin.length === 0) return articles;

  const enrichedMap = new Map();
  for (let i = 0; i < thin.length; i++) {
    const result = await enrichWithTimeout(thin[i]);
    enrichedMap.set(thin[i].url, result);
    if (i < thin.length - 1) await sleep(BETWEEN_DELAY);
  }

  const successCount = [...enrichedMap.values()].filter(a => a.contentEnriched).length;
  console.log(`[Phase 3] Enrichment done: ${successCount}/${thin.length} succeeded`);
  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

// ─── PHASE 4: ANALYZE (agents.js logic) ──────────────────────────────────────

function parseKeys(val) {
  if (!val) return [];
  return val.split(',').map(k => k.trim()).filter(Boolean);
}

const KEYS = {
  groq:       parseKeys(process.env.GROQ_API_KEY),
  sambanova:  parseKeys(process.env.SAMBANOVA_API_KEY),
  cerebras:   parseKeys(process.env.CEREBRAS_API_KEY),
  mistral:    parseKeys(process.env.MISTRAL_API_KEY),
  openrouter: parseKeys(process.env.OPENROUTER_API_KEY),
  gemini:     parseKeys(process.env.GEMINI_API_KEY),
};

// Provider implementations — exact port of agents.js
async function groqFast(prompt, key) {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function groq70b(prompt, key) {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.25, max_tokens: 2500 },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function sambanova(prompt, key) {
  const res = await axios.post('https://api.sambanova.ai/v1/chat/completions',
    { model: 'Meta-Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function cerebras(prompt, key) {
  const models = ['gpt-oss-120b', 'llama3.1-8b'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post('https://api.cerebras.ai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
      return res.data.choices[0]?.message?.content || '';
    } catch (err) { lastErr = err; if (err.response?.status !== 404) throw err; }
  }
  throw lastErr;
}

async function mistral(prompt, key) {
  const res = await axios.post('https://api.mistral.ai/v1/chat/completions',
    { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function openrouter(prompt, key) {
  const models = ['meta-llama/llama-3.3-70b:free', 'openai/gpt-oss-20b:free'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post('https://openrouter.ai/api/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                     'HTTP-Referer': 'https://github.com/mixta-africa', 'X-Title': 'Tola Edge Brief' }, timeout: TIMEOUT });
      return res.data.choices[0]?.message?.content || '';
    } catch (err) {
      lastErr = err;
      const s = err.response?.status;
      if (s !== 404 && s !== 400 && s !== 422) throw err;
    }
  }
  throw lastErr;
}

async function gemini(prompt, key) {
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1000 } },
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, timeout: TIMEOUT });
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) { lastErr = err; if (err.response?.status !== 404) throw err; }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fallback chains — exact order from agents.js
function articleProviders(prompt) {
  const chain = [];
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-8b (#${i+1})`,          fn: () => groqFast(prompt, key) }));
  KEYS.sambanova.forEach((key, i)  => chain.push({ name: `SambaNova (#${i+1})`,         fn: () => sambanova(prompt, key) }));
  KEYS.cerebras.forEach((key, i)   => chain.push({ name: `Cerebras (#${i+1})`,          fn: () => cerebras(prompt, key) }));
  KEYS.mistral.forEach((key, i)    => chain.push({ name: `Mistral (#${i+1})`,           fn: () => mistral(prompt, key) }));
  KEYS.openrouter.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`,        fn: () => openrouter(prompt, key) }));
  KEYS.gemini.forEach((key, i)     => chain.push({ name: `Gemini (#${i+1})`,            fn: () => gemini(prompt, key) }));
  return chain;
}

function synthesisProviders(prompt) {
  const chain = [];
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-70b (#${i+1})`,         fn: () => groq70b(prompt, key) }));
  KEYS.cerebras.forEach((key, i)   => chain.push({ name: `Cerebras (#${i+1})`,          fn: () => cerebras(prompt, key) }));
  KEYS.sambanova.forEach((key, i)  => chain.push({ name: `SambaNova (#${i+1})`,         fn: () => sambanova(prompt, key) }));
  KEYS.gemini.forEach((key, i)     => chain.push({ name: `Gemini (#${i+1})`,            fn: () => gemini(prompt, key) }));
  KEYS.mistral.forEach((key, i)    => chain.push({ name: `Mistral (#${i+1})`,           fn: () => mistral(prompt, key) }));
  KEYS.openrouter.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`,        fn: () => openrouter(prompt, key) }));
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-8b-Fallback (#${i+1})`, fn: () => groqFast(prompt, key) }));
  return chain;
}

async function runChain(providers, label) {
  if (providers.length === 0) throw new Error('No API keys configured');
  for (const provider of providers) {
    try {
      console.log(`  [${provider.name}] ${label}...`);
      const result = await provider.fn();
      if (result && result.trim()) return result;
      throw new Error('Empty response');
    } catch (err) {
      const status = err.response?.status;
      const msg = (err.response?.data?.error?.message || err.message || '?').substring(0, 100);
      console.warn(`  [${provider.name}] Failed (${status || 'ERR'}): ${msg}`);
      if (status === 429) await sleep(2000);
    }
  }
  throw new Error(`All providers failed: ${label}`);
}

// Article analysis prompt — exact port of agents.js buildAnalysisPrompt
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

// ─── PHASE 5: SYNTHESIZE (synthesizer.js adapted for brief spec schema) ───────

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

    return `[${i}] (${a.source || 'Unknown'}) ${a.title}
  Content quality: ${quality}
  Domain: ${a.domain || 'Unknown'} | Sentiment: ${a.sentiment || 'neutral'} | Severity: ${a.market_impact_severity || 'n/a'}
  Body: ${bodyText}
  URL: ${a.url || ''}`;
  }).join('\n\n');
}

function buildSynthesisPrompt(articles, mixtaContext, vaultContext) {
  const priorities   = (mixtaContext?.company?.strategic_priorities_2026 || []).map(p => `- ${p}`).join('\n');
  const watchList    = (mixtaContext?.watch_list || []).map(w => `- ${w.topic}: ${w.why}`).join('\n');
  const activeProjects = (mixtaContext?.active_projects || [])
    .filter(p => (p.location || '').toLowerCase().includes('lagos') || (p.location || '').toLowerCase().includes('lekki'))
    .map(p => `- ${p.name}: ${p.segment}. Open issues: ${(p.open_issues || []).join(', ') || 'None'}`)
    .join('\n');

  const activeDomainNames = ACTIVE_DOMAINS.map(d => DOMAIN_MAP[d]).filter(Boolean).join(', ');
  const marketScope = ACTIVE_MARKET === 'All' ? 'Nigeria (primary) and Senegal (secondary)' : ACTIVE_MARKET;

  const vaultSummary = vaultContext.length > 0
    ? 'PRIOR BRIEF CONTEXT (pattern recognition):\n' +
      vaultContext.map(v => `[${v.date}] ${(v.brief?.narrative || '').substring(0, 400)}...`).join('\n\n')
    : 'No prior briefs (first run).';

  const customSection = CUSTOM_PROMPT
    ? `\nTARGETED BRIEF REQUEST: "${CUSTOM_PROMPT}" — prioritise stories that directly address this.\n` : '';

  return `You are The Tola Edge Brief intelligence synthesis engine. You are the Head of Market Intelligence for Tola Akinsulire, Group Chief Commercial Officer at Mixta Africa.

Your job: convert the real, scraped news articles below into a crisp decision-grade executive brief for a senior CCO.

THE STRATEGIC THESIS:
Building homeownership infrastructure in Nigeria at the scale of Moniepoint's impact on payments — targeting the informal majority (83% of Nigerian employment) who have real purchasing power but no mortgage access.

MARKET SCOPE: ${marketScope}
ACTIVE DOMAINS: ${activeDomainNames}
DOMAIN PRIORITY: Market Creation > Capital & Financing > Land & Regulatory > Demand/Partnership > Geopolitical (threshold only)
${customSection}
ACTIVE PROJECTS:
${activeProjects}

STRATEGIC PRIORITIES 2026:
${priorities}

WATCH LIST:
${watchList}

${vaultSummary}

TODAY'S REAL SCRAPED ARTICLES:
${formatArticlesForSynthesis(articles)}

EDITORIAL RULES:
- Write in plain language for a senior decision-maker. Declarative, not tentative.
- High impact stories surface first. D5 Geopolitical only if genuinely alert-level.
- Every Mixta Relevance section must name specific projects, products, or priorities by name.
- HEADLINE ONLY content quality = treat as speculative, qualify your language.
- 4–6 stories maximum. Exercise editorial judgment — include what matters most.

HALLUCINATION GUARD: Every story must cite real article content from the sources above using [index] references. Do not invent facts not present in the articles.

Respond ONLY with valid JSON, no markdown, no preamble:
{
  "narrative": "Paragraph 1: highest-consequence Nigeria signal today.\\n\\nParagraph 2: key financing or Senegal signal.\\n\\nParagraph 3: most significant market creation or informal sector signal.\\n\\nParagraph 4: strategic synthesis — what today's intelligence means for Mixta this week.",
  "stories": [
    {
      "title": "Factual headline, not editorialised",
      "domain": "Capital & Financing Architecture | Land & Regulatory Alpha | Demand-Side Market Intelligence | Partnership & JV Origination Signals | Geopolitical & Country Risk | Market Creation Signals",
      "market": "Nigeria or Senegal",
      "impact": "High or Medium or Low",
      "body": "2-3 sentence factual summary with real figures from the source articles.",
      "relevance": "Specific commercial implication for Tola and Mixta — name active projects, pipelines, or strategic priorities explicitly.",
      "sources": [0, 1]
    }
  ]
}`;
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
    if (!story.title || !story.body || !story.relevance) continue;
    if (!VALID_DOMAINS.includes(story.domain)) {
      // Normalise domain if close enough
      const match = VALID_DOMAINS.find(d => d.toLowerCase().includes((story.domain || '').toLowerCase().split(' ')[0]));
      if (match) story.domain = match;
      else { console.warn(`[Validate] Dropping story — invalid domain: "${story.domain}"`); continue; }
    }
    if (!VALID_MARKETS.includes(story.market)) story.market = 'Nigeria';
    if (!VALID_IMPACTS.includes(story.impact)) story.impact = 'Medium';

    // Validate source indices (hallucination guard from synthesizer.js)
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

  // Sort High > Medium > Low, cap at 6
  const order = { High: 0, Medium: 1, Low: 2 };
  valid.sort((a, b) => (order[a.impact] ?? 2) - (order[b.impact] ?? 2));
  brief.stories = valid.slice(0, 6);

  return brief.stories.length > 0 ? brief : null;
}

async function synthesizeBrief(articles, mixtaContext, vaultContext) {
  console.log('[Phase 5] Synthesizing executive brief...');

  // Cooldown: let rate-limit window breathe after many article calls
  console.log('[Phase 5] Cooling down 20s before synthesis...');
  await sleep(20000);

  const prompt = buildSynthesisPrompt(articles, mixtaContext, vaultContext);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Phase 5] Synthesis attempt ${attempt}/${maxAttempts}...`);
      const raw = await runChain(synthesisProviders(prompt), `Synthesis attempt ${attempt}`);
      const parsed = parseBrief(raw);
      const validated = validateBrief(parsed, articles);
      if (validated) {
        console.log(`[Phase 5] Brief validated: ${validated.stories.length} stories`);
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
  console.log(`TOLA EDGE BRIEF — Intelligence Engine v2.0`);
  console.log(`Request: ${REQUEST_ID} | Market: ${ACTIVE_MARKET} | Domains: ${ACTIVE_DOMAINS.join(',')}`);
  console.log(`${'='.repeat(60)}\n`);

  const mixtaContext = loadMixtaContext();
  const vaultContext = loadVaultContext();
  console.log(`Vault: ${vaultContext.length} prior brief(s) loaded for context\n`);

  // Phase 1: Fetch
  const rawArticles = await fetchAllArticles();

  // Phase 2: Filter
  const filteredArticles = filterAndRankArticles(rawArticles);

  if (filteredArticles.length === 0) {
    throw new Error('No relevant articles found — check GNEWS_API_KEY and NEWSAPI_KEY secrets');
  }

  // Phase 3: Enrich
  const enrichedArticles = await enrichArticles(filteredArticles);

  // Phase 4: Analyze
  const analyzedArticles = await analyzeArticles(enrichedArticles, mixtaContext);

  // Phase 5: Synthesize
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
