/**
 * Synthesis Engine — the intelligence layer.
 *
 * Turns a list of analyzed articles into an executive briefing by:
 *  1. Loading Mixta's proprietary context (mixta-context.json)
 *  2. Loading theme memory (data/themes.json) for temporal tracking
 *  3. Asking the model to cluster today's articles into themes and write a
 *     decision-grade briefing connected to Mixta's actual position
 *  4. Updating theme memory so recurring themes can be flagged ("week 3", "new")
 *
 * Output is a structured briefing object consumed by the email + dashboard.
 */

const fs = require('fs');
const path = require('path');
const mixtaContext = require('./mixta-context.json');

class Synthesizer {
  constructor(agents) {
    this.agents = agents;
    this.contextPath = path.join(__dirname, 'mixta-context.json');
    this.memoryPath = path.join(process.cwd(), 'data', 'themes.json');
  }

  loadContext() {
    try {
      const raw = fs.readFileSync(this.contextPath, 'utf-8');
      const context = JSON.parse(raw);
      // Dashboard-edited watch-list overrides the file, if present
      if (Array.isArray(this.watchListOverride) && this.watchListOverride.length) {
        context.watch_list = this.watchListOverride;
      }
      return context;
    } catch (e) {
      console.warn('[Synthesis] Could not load mixta-context.json:', e.message);
      return null;
    }
  }

  loadMemory() {
    try {
      const raw = fs.readFileSync(this.memoryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.themes) ? parsed : { themes: [] };
    } catch (e) {
      return { themes: [] };
    }
  }

  /**
   * Build a compact, history-aware view of recurring themes for the prompt.
   * Returns lines like: "Government layout-approval fees — seen 3 prior runs, last 2026-06-12".
   */
  summarizeMemory(memory) {
    if (!memory.themes.length) return 'No prior theme history (first intelligent run).';
    return memory.themes
      .slice(-25)
      .map(t => `- "${t.label}" — seen ${t.count} prior run(s), last ${t.lastSeen}`)
      .join('\n');
  }

  /**
   * Compact the day's articles for the prompt. Index them so the model can cite sources.
   * Flags content quality so the model knows when it's working from real article text
   * vs a headline alone — this directly affects how it should qualify its analysis.
   */
  formatArticles(articles) {
    const { cleanContent } = require('./content-enricher');
    return articles.map((a, i) => {
      const rawContent = a.content || a.description || '';
      const cleaned = cleanContent(rawContent).trim();
      const hasBody = cleaned.length > 200;

      // Prefer enriched body; fall back to AI summary if it's real; finally use cleaned raw
      let bodyText;
      if (hasBody) {
        bodyText = cleaned.substring(0, 2000);
      } else if (a.summary && !a.summary.startsWith('Unable to generate')) {
        bodyText = a.summary;
      } else {
        bodyText = cleaned.substring(0, 300) || a.title || '';
      }

      const contentQuality = hasBody
        ? 'FULL TEXT'
        : (a.summary && !a.summary.startsWith('Unable to generate'))
          ? 'AI SUMMARY ONLY'
          : 'HEADLINE ONLY — treat all inferences as speculative';

      return `[${i}] (${a.source || 'Unknown'}) ${a.title}
  Content quality: ${contentQuality}
  Sentiment: ${a.sentiment || 'neutral'} | Severity: ${a.market_impact_severity || 'n/a'} | Topics: ${a.trending_topics || 'n/a'}
  Body: ${bodyText}
  URL: ${a.url || ''}`;
    }).join('\n\n');
  }

  buildPrompt(articles, context, memory) {
    // 1. Core Corporate Anchors
    const priorities = context?.company?.strategic_priorities_2026 || [];
    const activeProjects = context?.active_projects || [];
    const watchList = context?.watch_list || [];
    const pricingView = context?.internal_pricing_strategy_view || {};
    
    // 2. Format a compact, ultra-focused context block to avoid 413 token bloating
    const cleanPriorities = priorities.map(p => `- ${p}`).join('\n');
    const cleanWatchList = watchList.map(w => `- ${w.topic}: ${w.why}`).join('\n');
    
    // 3. Strict Nigerian Asset Realities
    const nigeriaProjects = activeProjects
      .filter(p => (p.location || '').toLowerCase().includes('lagos') || (p.location || '').toLowerCase().includes('lekki'))
      .map(p => `- ${p.name}: ${p.segment}. Open issues: ${(p.open_issues || []).join(', ') || 'None'}`).join('\n');

    return `You are The Tola Edge Brief intelligence synthesis engine, acting as the Head of Market Intelligence for Tola Akinsulire, Group Chief Commercial Officer at Mixta Africa. Your job is to convert raw Nigerian market signals into crisp, decision-grade executive briefs calibrated exclusively to Mixta's commercial runway.

VOICE AND STYLE:
- Write with ultimate business acumen: declarative, aggressive, and highly analytical[cite: 3].
- Never use passive or tentative phrasing ("may potentially affect"). State exactly HOW and HOW MUCH a market shift impacts our pipeline, land position, or sales receivables[cite: 3].
- The executive_summary MUST consist of exactly 4 clean, sequential paragraphs of prose (no markdown headings allowed)[cite: 3]:
  * Paragraph 1: The highest-consequence Nigeria macro/market signal today[cite: 3].
  * Paragraph 2: The key local financing, mortgage architecture, or banking partnership signal[cite: 3, 4].
  * Paragraph 3: The most critical Market Creation signal (informal majority formalization, fintech convergence like OPay/Moniepoint, housing infrastructure)[cite: 3].
  * Paragraph 4: Strategic synthesis — exactly what this collective intelligence implies for Mixta's Nigerian commercial execution this week[cite: 3].

======================================================================
NIGERIA CORE STRATEGIC CHANNELS
======================================================================
Evaluate all incoming data points against these specific domestic parameters:
- Focus Channels: CBN policy rate shifts, FMBN/NHF structural modifications, infrastructure arbitrage loops (Green Line Metro, Lekki-Epe Coastal Highway, Lekki Deep Seaport, Dangote Refinery).
- Commercial Touchpoints: Escalate or de-risk land banks, track the cash receivables gap, monitor MOFI MREIF mortgage allocations, and drive diaspora channel traction via the "Own It 4 Sure" framework[cite: 4].

=== ACTIVE PROJECTS IN COUNTRY SCOPE ===
${nigeriaProjects}

=== GENERAL MIXTA STRATEGIC ANCHORS ===
${cleanPriorities}
- Internal Pricing Matrix Strategy: ${pricingView.headline_argument || 'N/A'}

=== TRACKED DOMAINS & WATCHLIST ===
${cleanWatchList}

=== RECURRING THEME HISTORY (Temporal Memory) ===
${this.summarizeMemory(memory)}

=== TODAY'S ARTICLES DATA (Cite sources using [index] tokens) ===
${this.formatArticles(articles)}

=== EDITORIAL TASK ===
Isolate 3 to 5 high-impact themes moving the needle for Mixta[cite: 2]. Group correlated articles[cite: 2]. Every theme must explicitly link back to its commercial consequence regarding Nigerian asset allocation, receivables, or named projects[cite: 2].

Respond ONLY with a valid JSON block matching this structural layout exactly (no markdown formatting, no preambles)[cite: 2]:
{
  "executive_summary": "Paragraph 1 prose here.\\n\\nParagraph 2 prose here.\\n\\nParagraph 3 prose here.\\n\\nParagraph 4 prose here.",
  "themes": [
    {
      "label": "Sharp, specific theme name highlighting the structural shift",
      "market": "Nigeria",
      "novelty": "new | building | established",
      "what_happened": "One sentence reporting the hard empirical facts from the sources, including explicit metrics or figures.",
      "why_it_matters_to_mixta": "Clear commercial calculation of exposure or opportunity regarding asset allocation, receivables, or named projects.",
      "recommendation": "A clean, actionable commercial decision or direct trade-off proposal addressed to the CCO.",
      "confidence": "high | medium | low",
      "sources": [0, 1]
    }
  ],
  "watch_list_hits": ["Short note for each watch-list topic that surfaced today, or empty array"]
}`;
  }

  /**
   * Parse the model JSON defensively.
   */
  parseBriefing(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      const parsed = JSON.parse(match[0]);
      if (!parsed.themes) parsed.themes = [];
      if (!parsed.executive_summary) parsed.executive_summary = '';
      if (!parsed.watch_list_hits) parsed.watch_list_hits = [];
      return parsed;
    } catch (e) {
      console.error('[Synthesis] Failed to parse briefing JSON:', e.message);
      return null;
    }
  }

  /**
   * Update theme memory: increment count for themes seen before (fuzzy label match),
   * add new ones. Keeps a rolling window so the file does not grow unbounded.
   */
  updateMemory(memory, briefing, dateStr) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const existing = memory.themes;

    for (const theme of briefing.themes) {
      const label = theme.label || 'Untitled';
      const key = norm(label);
      // fuzzy match: same key, or one contains the other (handles slight rewording)
      const prior = existing.find(t => {
        const tk = norm(t.label);
        return tk === key || tk.includes(key) || key.includes(tk);
      });
      if (prior) {
        prior.count += 1;
        prior.lastSeen = dateStr;
        prior.label = label; // keep latest phrasing
      } else {
        existing.push({ label, count: 1, firstSeen: dateStr, lastSeen: dateStr });
      }
    }

    // Roll the window: keep most recently seen 60 themes
    existing.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    memory.themes = existing.slice(0, 60);
    return memory;
  }

  saveMemory(memory) {
    try {
      const dataDir = path.dirname(this.memoryPath);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(this.memoryPath, JSON.stringify(memory, null, 2));
      console.log('[Synthesis] Theme memory updated');
    } catch (e) {
      console.warn('[Synthesis] Could not save theme memory:', e.message);
    }
  }

  /**
   * Main entry: produce the briefing and persist theme memory.
   * Returns the briefing object (or null on failure — caller should degrade gracefully).
   */
  async synthesize(articles) {
    console.log('[PHASE 4.5] Synthesizing executive briefing...');

    if (!articles || articles.length === 0) {
      console.warn('[Synthesis] No articles to synthesize.');
      return null;
    }

    const context = this.loadContext();
    const memory = this.loadMemory();
    const prompt = this.buildPrompt(articles, context, memory);

    // Cooldown: the synthesis call follows many rapid article calls.
    // Give the rate-limit window time to reset before the big call.
    console.log('[Synthesis] Cooling down before synthesis call...');
    await new Promise(r => setTimeout(r, 60000));

    // Try up to 3 times; on a rate-limit (429) wait longer and retry.
    let briefing = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await this.agents.generateCompletion(prompt, `Executive briefing (attempt ${attempt})`);
        briefing = this.parseBriefing(raw);
        if (briefing) break;
        console.warn(`[Synthesis] Attempt ${attempt}: empty/unparseable response.`);
      } catch (e) {
        const is429 = /429/.test(e.message || '');
        console.warn(`[Synthesis] Attempt ${attempt} failed: ${e.message}`);
        if (attempt < maxAttempts) {
          const wait = is429 ? 30000 : 8000;
          console.log(`[Synthesis] Waiting ${wait / 1000}s before retry...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    if (!briefing) {
      console.error('[Synthesis] Could not produce briefing after retries.');
      return null;
    }

    // Hallucination guard: keep only citations that point to real articles.
    // Drop themes with no valid source; cap confidence for single-source themes.
    let invalidCitations = 0;
    const validThemes = [];
    for (const theme of briefing.themes) {
      const rawSources = Array.isArray(theme.sources) ? theme.sources : [];
      const validIdx = rawSources.filter(i => Number.isInteger(i) && i >= 0 && i < articles.length);
      invalidCitations += (rawSources.length - validIdx.length);

      if (validIdx.length === 0) {
        // No real source backs this theme — do not show it to leadership.
        console.warn(`[Synthesis] Dropping unsupported theme: "${theme.label}"`);
        continue;
      }

      theme.sources = validIdx;
      theme.sourceArticles = validIdx
        .map(idx => articles[idx])
        .filter(Boolean)
        .map(a => ({ title: a.title, url: a.url, source: a.source }));

      // Trust rule: a single-source theme cannot be "high" confidence.
      if (theme.sourceArticles.length < 2 && (theme.confidence || '').toLowerCase() === 'high') {
        theme.confidence = 'medium';
      }
      theme.singleSource = theme.sourceArticles.length < 2;

      validThemes.push(theme);
    }
    briefing.themes = validThemes;

    if (invalidCitations > 0) {
      console.warn(`[Synthesis] Removed ${invalidCitations} invalid source citation(s).`);
    }
    if (briefing.themes.length === 0) {
      console.error('[Synthesis] No themes survived citation validation.');
      return null;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const updated = this.updateMemory(memory, briefing, dateStr);
    this.saveMemory(updated);

    // Decorate themes with their tracked age for the email ("week 3")
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    for (const theme of briefing.themes) {
      const tracked = updated.themes.find(t => norm(t.label) === norm(theme.label));
      theme.timesSeen = tracked ? tracked.count : 1;
    }

    console.log(`[PHASE 4.5] Briefing ready: ${briefing.themes.length} themes`);
    return briefing;
  }
}

module.exports = Synthesizer;
