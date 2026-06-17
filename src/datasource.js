/**
 * Data Source Module
 * 
 * Collects articles from 4 sources:
 * 1. GNews API (~15-30 articles)
 * 2. NewsAPI (~20-40 articles)
 * 3. RSS Feeds (~10-20 articles)
 * 4. Direct URLs — user-configured manual overrides (NEW)
 */

const axios = require('axios');
const xml2js = require('xml2js');
const sourcesConfig = require('./sources.json');
const { quickMatch } = require('./relevance');

// Realistic browser headers — the old 'NewsBot' UA was getting 403-blocked
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

class DataSource {
  constructor() {
    this.gNewsApiKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.timeout = 12000;
    this.config = sourcesConfig;
    // Per-source health for the reliability layer, populated during fetches
    this.sourceHealth = {
      gnews: { ok: false, count: 0, error: null },
      newsapi: { ok: false, count: 0, error: null },
      googlenews: { ok: false, count: 0, error: null },
      rss: { total: 0, feeds: {} },
      directurls: { ok: false, count: 0, error: null },
    };
  }

  /**
   * Real estate keywords used to filter feed items at the source.
   */
  get realEstateKeywords() {
    return [
      'real estate', 'property', 'properties', 'housing', 'land', 'developer',
      'apartment', 'residential', 'commercial', 'construction', 'building',
      'lekki', 'ibeju-lekki', 'ikoyi', 'victoria island', 'epe', 'ajah',
      'property market', 'home sales', 'property prices', 'rent', 'rental',
      'mortgage', 'housing market', 'estate agent', 'realty', 'real-estate',
      'urban development', 'property developer', 'landlord', 'tenancy',
      'house', 'homes', 'plot', 'estate', 'REIT', 'shortlet', 'duplex',
    ];
  }

  matchesRealEstate(title, desc) {
    return quickMatch(title || '', desc || '');
  }

  /**
   * GNews API — targeted real estate query
   * FIX: Pointing correctly to gnews.io
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');
    if (!this.gNewsApiKey) {
      console.log('[GNews] Skipped — API key not configured');
      this.sourceHealth.gnews.error = 'API key missing';
      return [];
    }

    const queries = [
      '"real estate" Lagos',
      'property market Nigeria',
    ];

    const seen = new Set();
    const allArticles = [];

    for (const q of queries) {
      try {
        const response = await axios.get('https://gnews.io/api/v4/search', {
          params: {
            q,
            lang: 'en',
            country: 'ng',
            sortby: 'publishedAt',
            limit: 10,
            apikey: this.gNewsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        console.log(`[GNews] Query "${q}" → ${articles.length} articles`);

        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          allArticles.push({
            title: a.title,
            description: a.description,
            content: a.content,
            url: a.url,
            source: a.source?.name || 'GNews',
            publishedAt: a.publishedAt,
            image: a.image,
          });
        }
      } catch (error) {
        console.error(`[GNews] Error on query "${q}":`, error.message);
        this.sourceHealth.gnews.error = error.response?.status
          ? `HTTP ${error.response.status}` : error.message;
      }
    }

    console.log(`[GNews] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.gnews.count = allArticles.length;
    this.sourceHealth.gnews.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * NewsAPI — strict real estate query
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');
    if (!this.newsApiKey) {
      console.log('[NewsAPI] Skipped — API key not configured');
      this.sourceHealth.newsapi.error = 'API key missing';
      return [];
    }

    const queries = [
      '"real estate" AND (Lagos OR Nigeria)',
      '(property market OR housing market OR property developer OR mortgage) AND (Lagos OR Nigeria)',
    ];

    const seen = new Set();
    const allArticles = [];

    for (const q of queries) {
      try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
          params: {
            q,
            language: 'en',
            sortBy: 'publishedAt',
            pageSize: 20,
            apiKey: this.newsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        console.log(`[NewsAPI] Query "${q.substring(0, 40)}..." → ${articles.length} articles`);

        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          allArticles.push({
            title: a.title,
            description: a.description,
            content: a.content,
            url: a.url,
            source: a.source?.name || 'NewsAPI',
            publishedAt: a.publishedAt,
            image: a.urlToImage,
          });
        }
      } catch (error) {
        console.error(`[NewsAPI] Error on query "${q.substring(0, 40)}...":`, error.message);
        this.sourceHealth.newsapi.error = error.response?.status
          ? `HTTP ${error.response.status}` : error.message;
      }
    }

    console.log(`[NewsAPI] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.newsapi.count = allArticles.length;
    this.sourceHealth.newsapi.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * RSS Feeds — config-driven, browser-headered, keyword-filtered at source.
   * FIX: Added structural try/catch around XML string parsing to shield from broken publisher formats.
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');

    const rssFeeds = this.config.rssFeeds || [];
    const maxPer = this.config.settings?.maxPerRssFeed || 10;
    const parser = new xml2js.Parser();
    const allArticles = [];

    for (const feed of rssFeeds) {
      try {
        const response = await axios.get(feed.url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });

        // Parse XML safely
        let parsed;
        try {
          parsed = await parser.parseStringPromise(response.data);
        } catch (xmlError) {
          throw new Error(`XML Parsing Malformed Payload: ${xmlError.message}`);
        }

        const items = parsed?.rss?.channel?.[0]?.item || [];

        const articles = items
          .filter(item => this.matchesRealEstate(item.title?.[0], item.description?.[0]))
          .map(item => ({
            title: item.title?.[0] || '',
            description: item.description?.[0] || '',
            content: item['content:encoded']?.[0] || item.description?.[0] || '',
            url: item.link?.[0] || '',
            source: feed.source,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
            trustedSource: true,
          }))
          .slice(0, maxPer);

        allArticles.push(...articles);
        console.log(`[RSS] ${feed.source}: ${articles.length} real estate articles`);
        this.sourceHealth.rss.feeds[feed.source] = { ok: true, count: articles.length, error: null };
      } catch (error) {
        console.warn(`[RSS] Error fetching ${feed.source}:`, error.message);
        this.sourceHealth.rss.feeds[feed.source] = {
          ok: false,
          count: 0,
          error: error.response?.status ? `HTTP ${error.response.status}` : error.message,
        };
      }
    }

    console.log(`[RSS] Total: ${allArticles.length} articles`);
    this.sourceHealth.rss.total = allArticles.length;
    return allArticles;
  }

  /**
   * Google News RSS — query-based feeds.
   */
  async fetchGoogleNews() {
    console.log('[GoogleNews] Fetching query-based feeds...');

    const queries = this.config.googleNewsQueries || [];
    const maxPer = this.config.settings?.maxPerGoogleQuery || 8;
    const parser = new xml2js.Parser();
    const seen = new Set();
    const allArticles = [];
    let lastError = null;

    for (const query of queries) {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-NG&gl=NG&ceid=NG:en`;
      try {
        const response = await axios.get(url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });

        const parsed = await parser.parseStringPromise(response.data);
        const items = parsed?.rss?.channel?.[0]?.item || [];

        let added = 0;
        for (const item of items) {
          if (added >= maxPer) break;
          const rawTitle = item.title?.[0] || '';
          const sourceTag = item.source?.[0];
          const publisher = (typeof sourceTag === 'object' ? sourceTag._ : sourceTag)
            || (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop() : 'Google News');
          const title = rawTitle.includes(' - ')
            ? rawTitle.substring(0, rawTitle.lastIndexOf(' - ')).trim()
            : rawTitle;

          const key = title.toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          if (!this.matchesRealEstate(title, item.description?.[0])) continue;
          seen.add(key);

          allArticles.push({
            title,
            description: (item.description?.[0] || '').replace(/<[^>]+>/g, '').substring(0, 400),
            content: (item.description?.[0] || '').replace(/<[^>]+>/g, ''),
            url: item.link?.[0] || '',
            source: publisher,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
            trustedSource: true, // Forces bypass of standard whitelist gate in index.js
          });
          added++;
        }
        console.log(`[GoogleNews] "${query}": ${added} articles`);
      } catch (error) {
        lastError = error.response?.status ? `HTTP ${error.response.status}` : error.message;
        console.warn(`[GoogleNews] Error on "${query}":`, error.message);
      }
    }

    console.log(`[GoogleNews] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.googlenews.count = allArticles.length;
    this.sourceHealth.googlenews.ok = allArticles.length > 0;
    this.sourceHealth.googlenews.error = allArticles.length === 0 ? lastError : null;
    return allArticles;
  }

  /**
   * Direct URLs Source (Manual Override Configuration Engine)
   */
  async fetchDirectUrls() {
    let cfg;
    try {
      cfg = require('./NEWS_SOURCES_CONFIG.js');
    } catch (e) {
      console.log('[DirectURL] NEWS_SOURCES_CONFIG.js not found — skipping direct URLs');
      return [];
    }

    const urls = cfg?.directUrls?.urls || [];
    if (!cfg?.directUrls?.enabled || urls.length === 0) {
      console.log('[DirectURL] No direct URLs enabled or configured');
      return [];
    }

    console.log(`[DirectURL] Processing ${urls.length} manual overrides...`);
    const allArticles = [];

    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });
        const html = response.data || '';

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = (titleMatch?.[1] || 'Manual Real Estate Spotlight').trim();

        const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
        const description = (descMatch?.[1] || '').trim();

        allArticles.push({
          title,
          description,
          content: description, 
          url,
          source: 'Direct Configuration Override',
          publishedAt: new Date().toISOString(),
          trustedSource: true,  // Bypasses downstream gating strings entirely
        });
        console.log(`[DirectURL] Successfully extracted: ${title.substring(0, 50)}...`);
      } catch (error) {
        console.error(`[DirectURL] Failed processing execution on "${url}":`, error.message);
      }
    }

    console.log(`[DirectURL] Fetched ${allArticles.length} manual injection overrides`);
    this.sourceHealth.directurls.count = allArticles.length;
    this.sourceHealth.directurls.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * Fetch all sources
   */
  async fetchAll() {
    const [gnews, newsapi, rss, direct] = await Promise.allSettled([
      this.fetchGNews(),
      this.fetchNewsAPI(),
      this.fetchRSSFeeds(),
      this.fetchDirectUrls(),
    ]);

    return [
      gnews.status === 'fulfilled' ? gnews.value : [],
      newsapi.status === 'fulfilled' ? newsapi.value : [],
      rss.status === 'fulfilled' ? rss.value : [],
      direct.status === 'fulfilled' ? direct.value : [],
    ];
  }
}

module.exports = DataSource;
