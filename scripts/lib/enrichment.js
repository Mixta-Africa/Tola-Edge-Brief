/**
 * lib/enrichment.js
 *
 * Shared Puppeteer-based full-text extraction. No domain knowledge or
 * relevance logic — given an article with a thin description, navigates
 * to its URL and pulls the full article body. Safe to share between the
 * commercial daily engine and the thought-leadership engine.
 */

'use strict';

const puppeteer = require('puppeteer');
const { cleanContent } = require('./fetchers');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT    = 3000;
const HARD_TIMEOUT   = 30000;
const PAGE_TIMEOUT   = 20000;
const BETWEEN_DELAY  = 1500;

function usableLength(article) {
  return cleanContent(article.content || article.description || '').length;
}

async function safeBrowserClose(browser) {
  try { if (browser) await browser.close(); } catch (_) {}
}

async function attemptEnrich(article) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--no-zygote','--single-process','--memory-pressure-off'],
    });

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','media','font','stylesheet','websocket','manifest'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, 2500));

    const finalUrl = page.url();
    const extractedText = await page.evaluate(() => {
      if (!document.body) return '';
      document.querySelectorAll('script,style,nav,header,footer,aside,iframe,noscript,form,.ad,.sidebar,.comments').forEach(el => el.remove());
      const article = document.querySelector('article');
      if (article && article.innerText.trim().length > 200) return article.innerText.trim();
      for (const sel of ['.entry-content','.post-content','.article-body','.article-content','main','#main']) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 200) return el.innerText.trim();
      }
      const paras = Array.from(document.querySelectorAll('p')).map(p => p.innerText.trim()).filter(t => t.length > 20);
      if (paras.length) return paras.join(' ');
      return document.body.innerText.trim();
    });

    const cleanText = cleanContent(extractedText).substring(0, MAX_EXTRACT);
    await safeBrowserClose(browser);

    if (cleanText.length > 150) {
      console.log(`[Enricher] OK: ${cleanText.length} chars — "${article.title.substring(0,50)}"`);
      return { ...article, content: cleanText, resolvedUrl: finalUrl, contentEnriched: true };
    }
    console.log(`[Enricher] THIN: "${article.title.substring(0,50)}"`);
    return { ...article, contentEnriched: false };
  } catch (err) {
    await safeBrowserClose(browser);
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
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const thin    = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);
  console.log(`[Enrich] ${already.length} OK, ${thin.length} need enrichment`);

  if (thin.length === 0) return articles;

  const enrichedMap = new Map();
  for (let i = 0; i < thin.length; i++) {
    const result = await enrichWithTimeout(thin[i]);
    enrichedMap.set(thin[i].url, result);
    if (i < thin.length - 1) await sleep(BETWEEN_DELAY);
  }

  const successCount = [...enrichedMap.values()].filter(a => a.contentEnriched).length;
  console.log(`[Enrich] Enrichment done: ${successCount}/${thin.length} succeeded`);
  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = {
  enrichArticles,
  usableLength,
  THIN_THRESHOLD,
};
