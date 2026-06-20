/**
 * lib/fetchers.js
 *
 * Shared raw-article fetching: GNews, NewsAPI, Google News RSS, and generic
 * RSS feed parsing. No domain knowledge, no relevance scoring, no prompts —
 * just "given a query or feed URL, return article objects." Safe to share
 * between the commercial daily engine and the thought-leadership engine.
 */

'use strict';

const axios = require('axios');

const GNEWS_KEY   = process.env.GNEWS_API_KEY || '';
const NEWSAPI_KEY = process.env.NEWSAPI_KEY   || '';

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

async function fetchGNews(query, opts = {}) {
  if (!GNEWS_KEY) return [];
  const country = opts.country || 'ng';
  const lang = opts.lang || 'en';
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=${lang}&country=${country}&max=10&apikey=${GNEWS_KEY}`;
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

async function fetchGoogleNewsRSS(query, opts = {}) {
  const hl = opts.hl || 'en-NG';
  const gl = opts.gl || 'NG';
  const ceid = opts.ceid || 'NG:en';
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
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

/**
 * Runs an array of fetch promises (already-called, e.g. queries.map(fetchGNews))
 * in batches to avoid overwhelming APIs, with a short delay between batches.
 * Returns the flattened, settled results.
 */
async function runFetchesInBatches(fetchPromises, batchSize = 8, delayMs = 500) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = [];
  for (let i = 0; i < fetchPromises.length; i += batchSize) {
    const batch = await Promise.allSettled(fetchPromises.slice(i, i + batchSize));
    batch.forEach(r => { if (r.status === 'fulfilled') results.push(...r.value); });
    if (i + batchSize < fetchPromises.length) await sleep(delayMs);
  }
  return results;
}

module.exports = {
  cleanContent,
  fetchGNews,
  fetchNewsAPI,
  fetchGoogleNewsRSS,
  fetchRSSFeed,
  runFetchesInBatches,
  GNEWS_KEY,
  NEWSAPI_KEY,
};
