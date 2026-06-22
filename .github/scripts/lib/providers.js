/**
 * lib/providers.js
 *
 * Shared 6-provider LLM fallback chain, used by BOTH the daily commercial
 * engine (engine.js) and the weekly thought-leadership engine
 * (thought-leadership-engine.js).
 *
 * This file contains NO prompts, NO relevance logic, NO domain knowledge —
 * it is pure transport: "send this prompt string to provider X, get a
 * string back." Keeping it free of brief-specific logic is what makes it
 * safe to share between the two tracks without blurring their disciplines.
 *
 * max_tokens is parameterized per-call (not hardcoded) so callers can
 * request a small budget for per-article analysis and a larger budget
 * for full-brief synthesis, using the same provider functions.
 */

'use strict';

const axios = require('axios');

const TIMEOUT = 30000;

// Sensible default if a caller doesn't specify — matches the old
// hardcoded per-article analysis budget.
const DEFAULT_MAX_TOKENS = 1000;

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

// ─── PROVIDER IMPLEMENTATIONS ────────────────────────────────────────────────
// Each accepts (prompt, key, maxTokens). maxTokens defaults to the small
// per-article budget if the caller doesn't pass one, so existing call sites
// that don't specify it behave exactly as before.

async function groqFast(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function groq70b(prompt, key, maxTokens = 2500) {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.25, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function sambanova(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const res = await axios.post('https://api.sambanova.ai/v1/chat/completions',
    { model: 'Meta-Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function cerebras(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const models = ['gpt-oss-120b', 'llama3.1-8b'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post('https://api.cerebras.ai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
      return res.data.choices[0]?.message?.content || '';
    } catch (err) { lastErr = err; if (err.response?.status !== 404) throw err; }
  }
  throw lastErr;
}

async function mistral(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const res = await axios.post('https://api.mistral.ai/v1/chat/completions',
    { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
  return res.data.choices[0]?.message?.content || '';
}

async function openrouter(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const models = ['meta-llama/llama-3.3-70b:free', 'openai/gpt-oss-20b:free'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post('https://openrouter.ai/api/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens },
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

async function gemini(prompt, key, maxTokens = DEFAULT_MAX_TOKENS) {
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
  let lastErr;
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens } },
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, timeout: TIMEOUT });
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) { lastErr = err; if (err.response?.status !== 404) throw err; }
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── FALLBACK CHAINS ──────────────────────────────────────────────────────
// maxTokens flows through to every provider in the chain.

function articleProviders(prompt, maxTokens = DEFAULT_MAX_TOKENS) {
  const chain = [];
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-8b (#${i+1})`,          fn: () => groqFast(prompt, key, maxTokens) }));
  KEYS.sambanova.forEach((key, i)  => chain.push({ name: `SambaNova (#${i+1})`,         fn: () => sambanova(prompt, key, maxTokens) }));
  KEYS.cerebras.forEach((key, i)   => chain.push({ name: `Cerebras (#${i+1})`,          fn: () => cerebras(prompt, key, maxTokens) }));
  KEYS.mistral.forEach((key, i)    => chain.push({ name: `Mistral (#${i+1})`,           fn: () => mistral(prompt, key, maxTokens) }));
  KEYS.openrouter.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`,        fn: () => openrouter(prompt, key, maxTokens) }));
  KEYS.gemini.forEach((key, i)     => chain.push({ name: `Gemini (#${i+1})`,            fn: () => gemini(prompt, key, maxTokens) }));
  return chain;
}

function synthesisProviders(prompt, maxTokens = 2500) {
  const chain = [];
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-70b (#${i+1})`,         fn: () => groq70b(prompt, key, maxTokens) }));
  KEYS.cerebras.forEach((key, i)   => chain.push({ name: `Cerebras (#${i+1})`,          fn: () => cerebras(prompt, key, maxTokens) }));
  KEYS.sambanova.forEach((key, i)  => chain.push({ name: `SambaNova (#${i+1})`,         fn: () => sambanova(prompt, key, maxTokens) }));
  KEYS.gemini.forEach((key, i)     => chain.push({ name: `Gemini (#${i+1})`,            fn: () => gemini(prompt, key, maxTokens) }));
  KEYS.mistral.forEach((key, i)    => chain.push({ name: `Mistral (#${i+1})`,           fn: () => mistral(prompt, key, maxTokens) }));
  KEYS.openrouter.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`,        fn: () => openrouter(prompt, key, maxTokens) }));
  KEYS.groq.forEach((key, i)       => chain.push({ name: `Groq-8b-Fallback (#${i+1})`, fn: () => groqFast(prompt, key, maxTokens) }));
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

module.exports = {
  KEYS,
  parseKeys,
  sleep,
  runChain,
  articleProviders,
  synthesisProviders,
  // Exported individually in case a track needs a custom chain order/composition
  groqFast, groq70b, sambanova, cerebras, mistral, openrouter, gemini,
  DEFAULT_MAX_TOKENS,
};
