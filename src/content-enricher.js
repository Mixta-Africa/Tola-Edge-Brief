/**
 * Content Enricher v4.1 — One Browser Per Article + Hard Process Timeout
 *
 * Three bugs fixed vs v3.x:
 *
 * BUG 1 (CRASH): Shared browser session dies mid-batch (OS OOM killer hits
 *   the Chromium child process). Fix: spawn a fresh browser per article.
 *   One browser dies → only that article fails. Batch continues.
 *
 * BUG 2 (HANG): page.goto() freezes indefinitely on some Google News redirect
 *   URLs because domcontentloaded never fires. The 25s Puppeteer timeout is
 *   not always honoured when --single-process is active. Fix: wrap the entire
 *   per-article attempt in a Promise.race() against a hard 30s wall-clock kill.
 *
 * BUG 3 (MEMORY): Loading images/fonts/media burns RAM and slows page load,
 *   increasing the chance of timeout. Fix: intercept and abort all non-text
 *   resource types before navigation.
 */

const puppeteer = require('puppeteer');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT    = 3000;
const HARD_TIMEOUT   = 30000; // Wall-clock kill per article — overrides everything
const PAGE_TIMEOUT   = 20000; // Puppeteer goto timeout (inside the hard timeout)
const BETWEEN_DELAY  =  1500; // OS memory reclaim pause between browser launches

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

async function safeBrowserClose(browser) {
  try { if (browser) await browser.close(); } catch (_) {}
}

/**
 * Attempt to enrich one article using a fully isolated browser instance.
 * Returns enriched article on success, original article on any failure.
 * No retries — if the browser or page dies, we move on cleanly.
 */
async function attemptEnrich(article) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--memory-pressure-off',
      ]
    });

    const page = await browser.newPage();

    // Block images, fonts, media — we only need text
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'media', 'font', 'stylesheet', 'websocket', 'manifest'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate — use 'load' not 'domcontentloaded'; some redirects fire load before dom
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // Wait for JS redirects (Google News, Cloudflare) — capped so we don't add to a hang
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

      const paras = Array.from(document.querySelectorAll('p'))
        .map(p => p.innerText.trim()).filter(t => t.length > 20);
      if (paras.length) return paras.join(' ');

      return document.body.innerText.trim();
    });

    const cleanText = cleanContent(extractedText).substring(0, MAX_EXTRACT);
    await safeBrowserClose(browser);

    if (cleanText.length > 150) {
      console.log(`[Enricher] SUCCESS: ${cleanText.length} chars from ${finalUrl.substring(0, 60)}`);
      return { ...article, content: cleanText, resolvedUrl: finalUrl, contentEnriched: true };
    }

    console.log(`[Enricher] THIN: no usable text — "${article.title.substring(0, 50)}"`);
    return { ...article, contentEnriched: false };

  } catch (err) {
    await safeBrowserClose(browser);
    // Surface only the first line — stack traces are noise in pipeline logs
    console.error(`[Enricher] FAILED: "${article.title.substring(0, 50)}" — ${err.message.split('\n')[0]}`);
    return { ...article, contentEnriched: false };
  }
}

/**
 * Hard wall-clock timeout wrapper.
 * If attemptEnrich doesn't resolve within HARD_TIMEOUT ms (for any reason —
 * hung goto, frozen evaluate, dead process), this kills it and returns the
 * original article so the batch continues.
 */
function enrichWithTimeout(article) {
  return Promise.race([
    attemptEnrich(article),
    new Promise(resolve =>
      setTimeout(() => {
        console.error(`[Enricher] TIMEOUT (${HARD_TIMEOUT}ms): "${article.title.substring(0, 50)}" — skipping`);
        resolve({ ...article, contentEnriched: false });
      }, HARD_TIMEOUT)
    )
  ]);
}

async function enrichArticles(articles) {
  const thin    = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) return articles;

  console.log(`[Enricher] ${already.length} OK, ${thin.length} need enrichment (${HARD_TIMEOUT / 1000}s hard timeout each)`);

  const enrichedMap = new Map();

  for (let i = 0; i < thin.length; i++) {
    const article = thin[i];
    const result  = await enrichWithTimeout(article);
    enrichedMap.set(article.url, result);

    // Brief pause between launches so the OS can reclaim RAM
    if (i < thin.length - 1) {
      await new Promise(r => setTimeout(r, BETWEEN_DELAY));
    }
  }

  const successCount = [...enrichedMap.values()].filter(a => a.contentEnriched).length;
  console.log(`[Enricher] Done. ${successCount}/${thin.length} enriched successfully.`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
