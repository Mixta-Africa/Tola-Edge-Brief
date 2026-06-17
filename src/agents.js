/**
 * AI Agents Module — Multi-Key Fallback Chain
 *
 * Priority order:
 * 1. Groq        — fastest, adequate for summaries
 * 2. SambaNova   — persistent free tier, excellent reasoning
 * 3. Cerebras    — rapid generation
 * 4. Mistral     — generous monthly limits
 * 5. OpenRouter  — massive free model rotation
 * 6. Gemini      — generous daily limits
 *
 * NEW: Multi-Key Support
 * You can now pass multiple API keys separated by commas in your environment variables.
 * E.g., GROQ_API_KEY="key1,key2". The system will automatically try Key 1, and if it
 * rate-limits, it will seamlessly fall back to Key 2 before moving to SambaNova.
 */

const axios = require('axios');
const mixtaContext = require('./mixta-context.json');

const TIMEOUT = 20000;

class Agents {
  constructor() {
    // Parse comma-separated keys into arrays
    this.groqKeys       = this._parseKeys(process.env.GROQ_API_KEY);
    this.geminiKeys     = this._parseKeys(process.env.GEMINI_API_KEY);
    this.sambanovaKeys  = this._parseKeys(process.env.SAMBANOVA_API_KEY);
    this.mistralKeys    = this._parseKeys(process.env.MISTRAL_API_KEY);
    this.openrouterKeys = this._parseKeys(process.env.OPENROUTER_API_KEY);
    this.cerebrasKeys   = this._parseKeys(process.env.CEREBRAS_API_KEY);
  }

  _parseKeys(keyString) {
    if (!keyString) return [];
    return keyString.split(',').map(k => k.trim()).filter(Boolean);
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async analyzeArticle(article) {
    const hasContent =
      (article.title && article.title.trim()) ||
      (article.description && article.description.trim()) ||
      (article.content && article.content.trim());

    if (!hasContent) {
      console.warn(`[Agents] Skipping article with no content (source: ${article.source || 'unknown'})`);
      return this.defaultAnalysis();
    }

    const prompt = this.buildAnalysisPrompt(article);
    const result = await this._complete(prompt, `Analyzing: ${(article.title || 'untitled').substring(0, 60)}`);
    return this.parseAnalysis(result);
  }

  async generateCompletion(prompt, label = 'Synthesis') {
    return this._complete(prompt, label);
  }

  // ─── CORE FALLBACK ENGINE ────────────────────────────────────────────────────

  async _complete(prompt, label) {
    if (!prompt || !prompt.trim()) {
      console.error(`[Agents] Refusing to send empty prompt for: ${label}`);
      return null;
    }

    const isArticle = label.startsWith('Analyzing:');
    const providers = isArticle ? this._articleProviders(prompt) : this._synthesisProviders(prompt);

    if (providers.length === 0) {
      console.error(`[Agents] No API keys configured for any provider!`);
      return null;
    }

    for (const provider of providers) {
      try {
        console.log(`[${provider.name}] ${label}...`);
        const result = await provider.fn();
        if (result && result.trim()) return result;
        throw new Error('Empty response');
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
        console.warn(`[${provider.name}] Failed (${status || 'ERR'}): ${msg.substring(0, 120)}`);
        if (status === 429) await this._sleep(2000); // Backoff before hitting the next key/provider
      }
    }

    console.error(`[Agents] All providers and keys failed for: ${label}`);
    return null;
  }

  /**
   * Dynamically build the article provider chain based on available keys.
   */
  _articleProviders(prompt) {
    const chain = [];
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-8b (#${i+1})`, fn: () => this._groqFast(prompt, key) }));
    this.sambanovaKeys.forEach((key, i) => chain.push({ name: `SambaNova (#${i+1})`, fn: () => this._sambanova(prompt, key) }));
    this.cerebrasKeys.forEach((key, i) => chain.push({ name: `Cerebras (#${i+1})`, fn: () => this._cerebras(prompt, key) }));
    this.mistralKeys.forEach((key, i) => chain.push({ name: `Mistral (#${i+1})`, fn: () => this._mistral(prompt, key) }));
    this.openrouterKeys.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`, fn: () => this._openrouter(prompt, key) }));
    this.geminiKeys.forEach((key, i) => chain.push({ name: `Gemini (#${i+1})`, fn: () => this._gemini(prompt, key) }));
    return chain;
  }

  /**
   * Dynamically build the synthesis provider chain based on available keys.
   */
  _synthesisProviders(prompt) {
    const chain = [];
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-70b (#${i+1})`, fn: () => this._groq70b(prompt, key) }));
    this.cerebrasKeys.forEach((key, i) => chain.push({ name: `Cerebras (#${i+1})`, fn: () => this._cerebras(prompt, key) }));
    this.sambanovaKeys.forEach((key, i) => chain.push({ name: `SambaNova (#${i+1})`, fn: () => this._sambanova(prompt, key) }));
    this.geminiKeys.forEach((key, i) => chain.push({ name: `Gemini (#${i+1})`, fn: () => this._gemini(prompt, key) }));
    this.mistralKeys.forEach((key, i) => chain.push({ name: `Mistral (#${i+1})`, fn: () => this._mistral(prompt, key) }));
    this.openrouterKeys.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`, fn: () => this._openrouter(prompt, key) }));
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-8b-Fallback (#${i+1})`, fn: () => this._groqFast(prompt, key) }));
    return chain;
  }

  // ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────

  async _groqFast(prompt, key) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _groq70b(prompt, key) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _gemini(prompt, key) {
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1000 } },
          { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, timeout: TIMEOUT }
        );
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) throw err; 
      }
    }
    throw lastErr;
  }

  async _sambanova(prompt, key) {
    const res = await axios.post(
      'https://api.sambanova.ai/v1/chat/completions',
      { model: 'Meta-Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _cerebras(prompt, key) {
    const models = ['gpt-oss-120b', 'llama3.1-8b'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          'https://api.cerebras.ai/v1/chat/completions',
          { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) throw err;
      }
    }
    throw lastErr;
  }

  async _mistral(prompt, key) {
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _openrouter(prompt, key) {
    const models = ['meta-llama/llama-3.3-70b:free', 'openai/gpt-oss-20b:free'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/mixta-africa', 'X-Title': 'Mixta News Pipeline' }, timeout: TIMEOUT }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status !== 404 && status !== 400 && status !== 422) throw err;
      }
    }
    throw lastErr;
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

  // ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

  buildAnalysisPrompt(article) {
    const title   = (article.title   || '').trim() || 'Untitled';
    const source  = (article.source  || '').trim() || 'Unknown source';
    const url     = (article.url     || '').trim() || 'No URL';
    const content = (article.content || article.description || article.title || '').trim().substring(0, 1000);

    // Dynamically pull the latest intel from mixta-context.json
    const activeProjects = mixtaContext.active_projects.map(p => p.name).join(', ');
    const competitors = mixtaContext.competitors.map(c => c.name).slice(0, 10).join(', '); // Top 10 to save tokens
    const strategicPriorities = mixtaContext.company.strategic_priorities_2026.join('; ');

    return `You are a professional real estate analyst for a major Lagos-based developer (Mixta Africa).
Analyze this article with intellectual rigor and business acumen.

COMPANY CONTEXT:
- Strategic Priorities: ${strategicPriorities}
- Active Projects: ${activeProjects}
- Key Competitors: ${competitors}

ARTICLE:
Title: ${title}
Source: ${source}
URL: ${url}
Content: ${content}

ANALYSIS REQUIREMENTS:

1. PROFESSIONAL SUMMARY (2-3 sentences, analyst tone):
   - Focus on what this MEANS for Lagos real estate market
   - Example: "Infrastructure delays in Lekki threaten Q3 occupancy, pressuring new launches."

2. MARKET IMPACT:
   - Severity: critical | high | medium | low | negligible
   - Affected segments: affordable housing | mid-market | premium | commercial | industrial
   - Geographic radius: Lagos | Southwest Nigeria | National
   - Timeframe: immediate | near-term | medium-term | long-term

3. MIXTA AFRICA RELEVANCE:
   - Direct impact: How does this affect our strategic priorities or active projects?
   - Indirect impact: Does this affect pricing, costs, regulatory environment, or our competitors?
   - Strategic opportunity: Does this create advantage?
   - Risk flag: Does this threaten execution?

4. SENTIMENT: bullish | bearish | neutral (justify in 1 sentence)

5. LOCATION TAGS: Lagos, Lekki, Ibeju-Lekki, etc.

6. CATEGORY: property-market | policy | developer-news | investment | infrastructure

7. TRENDING TOPICS: Comma-separated tags (e.g., "prices, inflation, infrastructure")

RESPOND ONLY IN THIS JSON FORMAT (no markdown, no explanation):
{
  "summary": "Professional 2-3 sentence summary",
  "sentiment": "bullish|bearish|neutral",
  "location_tags": "Lagos,Lekki,Ibeju-Lekki",
  "category": "property-market,infrastructure",
  "trending_topics": "prices,infrastructure",
  "market_impact_severity": "critical|high|medium|low|negligible",
  "affected_segments": "affordable housing,premium",
  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",
  "mixta_relevance": {
    "direct_impact": "Description or None",
    "indirect_impact": "Description or None",
    "strategic_opportunity": "Description or None",
    "risk_flag": "Description or None"
  }
}`;
  }
  // ─── RESPONSE PARSING ────────────────────────────────────────────────────────

  parseAnalysis(responseText) {
    if (!responseText) return this.defaultAnalysis();
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary:                  parsed.summary                  || '',
        sentiment:                this.normalizeSentiment(parsed.sentiment),
        category:                 parsed.category                 || 'untagged',
        location_tags:            parsed.location_tags            || '',
        trending_topics:          parsed.trending_topics          || '',
        market_impact_severity:   parsed.market_impact_severity   || 'low',
        affected_segments:        parsed.affected_segments        || '',
        market_impact_timeframe:  parsed.market_impact_timeframe  || 'medium-term',
        mixta_relevance: parsed.mixta_relevance || {
          direct_impact:        'None',
          indirect_impact:      'None',
          strategic_opportunity:'None',
          risk_flag:            'None',
        },
      };
    } catch (err) {
      console.error('[Agents] Parse error:', err.message);
      return this.defaultAnalysis();
    }
  }

  normalizeSentiment(value) {
    const v = (value || '').toLowerCase();
    if (v.includes('bull')) return 'bullish';
    if (v.includes('bear')) return 'bearish';
    return 'neutral';
  }

  defaultAnalysis() {
    return {
      summary:                 'Unable to generate summary — all AI providers unavailable.',
      sentiment:               'neutral',
      category:                'untagged',
      location_tags:           '',
      trending_topics:         '',
      market_impact_severity:  'unknown',
      affected_segments:       '',
      market_impact_timeframe: 'unknown',
      mixta_relevance: {
        direct_impact:         'Unable to determine',
        indirect_impact:       'Unable to determine',
        strategic_opportunity: 'Unable to determine',
        risk_flag:             'Unable to determine',
      },
    };
  }
}

module.exports = Agents;
