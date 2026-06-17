/**
 * Google Sheets Client Module
 * 
 * Handles:
 * - Appending new articles
 * - Querying historical data
 * - Calculating trends
 * - Searching and filtering
 */

const { google } = require('googleapis');
const Buffer = require('buffer').Buffer;

class SheetsClient {
  constructor() {
    this.spreadsheetId = process.env.SPREADSHEET_ID;
    this.credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
    this.auth = null;
    this.sheets = null;
    this.initializeAuth();
  }

  /**
   * Initialize Google Sheets authentication
   */
  initializeAuth() {
    try {
      if (!this.credentialsJson) {
        throw new Error('GOOGLE_SHEETS_CREDENTIALS not set in environment');
      }

      // Decode base64 credentials
      const credentialsBuffer = Buffer.from(this.credentialsJson, 'base64');
      const credentials = JSON.parse(credentialsBuffer.toString('utf8'));

      this.auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      console.log('[Sheets] Authentication initialized');
    } catch (error) {
      console.error('[Sheets] Auth error:', error.message);
      throw error;
    }
  }

  /**
   * Append rows to Google Sheet
   */
  async appendRows(values) {
    try {
      if (!this.sheets) throw new Error('Sheets not initialized');

      const resource = {
        values: values,
      };

      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: 'Sheet1!A:J',
        valueInputOption: 'USER_ENTERED',
        resource: resource,
      });

      console.log(`[Sheets] Appended ${values.length} rows`);
      return response.data;
    } catch (error) {
      console.error('[Sheets] Append error:', error.message);
      throw error;
    }
  }

  /**
   * Get all values from sheet
   */
  async getAllRows() {
    try {
      if (!this.sheets) throw new Error('Sheets not initialized');

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: 'Sheet1!A:J',
      });

      const rows = response.data?.values || [];
      console.log(`[Sheets] Retrieved ${rows.length} total rows`);
      return rows;
    } catch (error) {
      console.error('[Sheets] Get error:', error.message);
      return [];
    }
  }

  /**
   * Query rows by date range
   */
  async getRowsByDateRange(startDate, endDate) {
    try {
      const allRows = await this.getAllRows();
      
      const filtered = allRows.filter(row => {
        const rowDate = new Date(row[0]);
        return rowDate >= startDate && rowDate <= endDate;
      });

      console.log(`[Sheets] Found ${filtered.length} rows in date range`);
      return filtered;
    } catch (error) {
      console.error('[Sheets] Date range query error:', error.message);
      return [];
    }
  }

  /**
   * Get articles from last N days
   */
  async getRecentArticles(days = 7) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const rows = await this.getRowsByDateRange(startDate, endDate);
      return rows.map(row => ({
        date: row[0],
        source: row[1],
        title: row[2],
        url: row[3],
        category: row[4],
        sentiment: row[5],
        summary: row[6],
        mixta_flags: row[7],
        notes: row[8],
        timestamp: row[9],
      }));
    } catch (error) {
      console.error('[Sheets] Recent articles query error:', error.message);
      return [];
    }
  }

  /**
   * Search articles by keyword
   */
  async searchArticles(keyword) {
    try {
      const allRows = await this.getAllRows();
      
      const results = allRows.filter(row => {
        const searchText = `${row[1]} ${row[2]} ${row[6]}`.toLowerCase();
        return searchText.includes(keyword.toLowerCase());
      });

      console.log(`[Sheets] Found ${results.length} articles matching "${keyword}"`);
      return results;
    } catch (error) {
      console.error('[Sheets] Search error:', error.message);
      return [];
    }
  }

  /**
   * Calculate sentiment distribution
   */
  async calculateSentimentDistribution(days = 7) {
    try {
      const articles = await this.getRecentArticles(days);
      
      const distribution = {
        bullish: 0,
        bearish: 0,
        neutral: 0,
      };

      for (const article of articles) {
        const sentiment = (article.sentiment || 'neutral').toLowerCase();
        if (sentiment in distribution) {
          distribution[sentiment]++;
        }
      }

      const total = articles.length;
      const percentage = {
        bullish: total > 0 ? ((distribution.bullish / total) * 100).toFixed(1) : 0,
        bearish: total > 0 ? ((distribution.bearish / total) * 100).toFixed(1) : 0,
        neutral: total > 0 ? ((distribution.neutral / total) * 100).toFixed(1) : 0,
      };

      console.log(`[Sheets] Sentiment distribution:`, percentage);
      return { count: distribution, percentage };
    } catch (error) {
      console.error('[Sheets] Sentiment calculation error:', error.message);
      return { count: {}, percentage: {} };
    }
  }

  /**
   * Get top sources
   */
  async getTopSources(days = 7, limit = 10) {
    try {
      const articles = await this.getRecentArticles(days);
      
      const sources = {};
      for (const article of articles) {
        const source = article.source || 'Unknown';
        sources[source] = (sources[source] || 0) + 1;
      }

      const sorted = Object.entries(sources)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([source, count]) => ({ source, count }));

      console.log(`[Sheets] Top sources:`, sorted);
      return sorted;
    } catch (error) {
      console.error('[Sheets] Top sources error:', error.message);
      return [];
    }
  }

  /**
   * Get most Mixta-relevant articles
   */
  async getMixtaRelevantArticles(days = 7) {
    try {
      const articles = await this.getRecentArticles(days);
      
      const relevant = articles.filter(article => 
        article.mixta_flags && article.mixta_flags.trim() !== ''
      );

      console.log(`[Sheets] Found ${relevant.length} Mixta-relevant articles`);
      return relevant;
    } catch (error) {
      console.error('[Sheets] Mixta relevant query error:', error.message);
      return [];
    }
  }

  /**
   * Get category breakdown
   */
  async getCategoryBreakdown(days = 7) {
    try {
      const articles = await this.getRecentArticles(days);
      
      const categories = {};
      for (const article of articles) {
        const category = article.category || 'untagged';
        categories[category] = (categories[category] || 0) + 1;
      }

      const sorted = Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => ({ category, count }));

      console.log(`[Sheets] Category breakdown:`, sorted);
      return sorted;
    } catch (error) {
      console.error('[Sheets] Category breakdown error:', error.message);
      return [];
    }
  }
}

module.exports = SheetsClient;
