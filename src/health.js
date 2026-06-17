/**
 * Reliability Layer — run health monitoring & operator alerting.
 *
 * Purpose: leadership reads the daily digest, so the operator (you) must learn
 * a run failed or degraded BEFORE leadership notices. This module:
 *   1. Collects a structured health record across the run
 *   2. Judges status: healthy | degraded | failed
 *   3. Persists data/health.json (latest) + data/health-history.json (rolling)
 *   4. Builds an operator alert email when status is not healthy
 *
 * Thresholds are conservative defaults; tune in the constructor.
 */

const fs = require('fs');
const path = require('path');

class RunHealth {
  constructor(timestamp) {
    this.timestamp = timestamp || new Date().toISOString();
    this.record = {
      timestamp: this.timestamp,
      status: 'unknown',
      sources: {},
      counts: { raw: 0, filtered: 0, analyzed: 0, aiFallbacks: 0 },
      synthesis: { ok: false, themes: 0 },
      email: { sent: false },
      warnings: [],
    };

    // Tunable thresholds
    this.MIN_FILTERED = 4;        // fewer than this = thin run (degraded)
    this.MAX_AI_FALLBACK_RATIO = 0.5; // >50% articles without real summary = degraded
    this.MAX_SOURCES_DOWN = 2;    // collection sources fully down before flagging
  }

  recordSources(sourceHealth) {
    this.record.sources = sourceHealth || {};
  }

  recordCounts({ raw, filtered, analyzed, aiFallbacks }) {
    if (raw != null) this.record.counts.raw = raw;
    if (filtered != null) this.record.counts.filtered = filtered;
    if (analyzed != null) this.record.counts.analyzed = analyzed;
    if (aiFallbacks != null) this.record.counts.aiFallbacks = aiFallbacks;
  }

  recordSynthesis(briefing) {
    this.record.synthesis.ok = !!briefing;
    this.record.synthesis.themes = briefing?.themes?.length || 0;
  }

  recordEmail(sent) {
    this.record.email.sent = !!sent;
  }

  addWarning(msg) {
    this.record.warnings.push(msg);
  }

  /**
   * Count how many collection sources are fully down (0 articles / errored).
   */
  countSourcesDown() {
    const s = this.record.sources;
    let down = 0;
    const downList = [];
    if (s.gnews && !s.gnews.ok) { down++; downList.push(`GNews (${s.gnews.error || '0 articles'})`); }
    if (s.newsapi && !s.newsapi.ok) { down++; downList.push(`NewsAPI (${s.newsapi.error || '0 articles'})`); }
    if (s.rss && s.rss.feeds) {
      for (const [name, f] of Object.entries(s.rss.feeds)) {
        if (!f.ok) downList.push(`RSS ${name} (${f.error || 'failed'})`);
      }
    }
    return { down, downList };
  }

  /**
   * Decide overall status and assemble warnings.
   * failed   = no usable output (no articles or email never sent)
   * degraded = output produced but below trust bar (thin, no briefing, sources eroding)
   * healthy  = all good
   */
  finalize({ fatal = false } = {}) {
    const c = this.record.counts;
    const { down, downList } = this.countSourcesDown();

    // Source erosion is always worth surfacing, even on healthy runs
    if (downList.length) {
      this.addWarning(`Sources down: ${downList.join('; ')}`);
    }

    if (fatal || c.raw === 0 || c.filtered === 0 || !this.record.email.sent) {
      this.record.status = 'failed';
      if (c.raw === 0) this.addWarning('No articles collected from any source.');
      else if (c.filtered === 0) this.addWarning('No articles passed real-estate filtering.');
      if (!this.record.email.sent) this.addWarning('Digest email was NOT sent.');
      return this.record;
    }

    const degradedReasons = [];
    if (!this.record.synthesis.ok) degradedReasons.push('Executive briefing failed to generate (digest fell back to article list).');
    if (c.filtered < this.MIN_FILTERED) degradedReasons.push(`Only ${c.filtered} articles after filtering (below ${this.MIN_FILTERED}).`);
    const fallbackRatio = c.analyzed ? c.aiFallbacks / c.analyzed : 0;
    if (fallbackRatio > this.MAX_AI_FALLBACK_RATIO) {
      degradedReasons.push(`${Math.round(fallbackRatio * 100)}% of articles had no AI summary.`);
    }
    if (down >= this.MAX_SOURCES_DOWN) {
      degradedReasons.push(`${down} primary collection source(s) down.`);
    }

    if (degradedReasons.length) {
      this.record.status = 'degraded';
      degradedReasons.forEach(r => this.addWarning(r));
    } else {
      this.record.status = 'healthy';
    }
    return this.record;
  }

  /**
   * Persist latest + rolling history (last 60 runs).
   */
  persist() {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      fs.writeFileSync(path.join(dataDir, 'health.json'), JSON.stringify(this.record, null, 2));

      const histPath = path.join(dataDir, 'health-history.json');
      let history = [];
      try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')).runs || []; } catch (e) { history = []; }
      history.push({
        timestamp: this.record.timestamp,
        status: this.record.status,
        filtered: this.record.counts.filtered,
        themes: this.record.synthesis.themes,
        warnings: this.record.warnings.length,
      });
      history = history.slice(-60);
      fs.writeFileSync(histPath, JSON.stringify({ runs: history }, null, 2));
      console.log(`[Health] Run status: ${this.record.status.toUpperCase()}`);
    } catch (e) {
      console.warn('[Health] Could not persist health data:', e.message);
    }
  }

  /**
   * True when the operator should be alerted.
   */
  needsAlert() {
    return this.record.status === 'failed' || this.record.status === 'degraded';
  }

  /**
   * Build the operator alert email (plain, scannable, no emojis).
   */
  buildAlertEmail() {
    const r = this.record;
    const color = r.status === 'failed' ? '#c0392b' : '#b8860b';
    const sourceRows = [];

    if (r.sources.gnews) sourceRows.push(`GNews: ${r.sources.gnews.ok ? 'OK' : 'DOWN'} (${r.sources.gnews.count} articles${r.sources.gnews.error ? ', ' + r.sources.gnews.error : ''})`);
    if (r.sources.newsapi) sourceRows.push(`NewsAPI: ${r.sources.newsapi.ok ? 'OK' : 'DOWN'} (${r.sources.newsapi.count} articles${r.sources.newsapi.error ? ', ' + r.sources.newsapi.error : ''})`);
    if (r.sources.rss && r.sources.rss.feeds) {
      for (const [name, f] of Object.entries(r.sources.rss.feeds)) {
        sourceRows.push(`RSS ${name}: ${f.ok ? 'OK' : 'DOWN'} (${f.count} articles${f.error ? ', ' + f.error : ''})`);
      }
    }

    const html = `
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:20px;background:#ffffff;">
      <div style="background:${color};color:#fff;padding:16px 20px;border-radius:6px;">
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">Pipeline Operator Alert</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;">Run status: ${r.status.toUpperCase()}</div>
        <div style="font-size:12px;opacity:0.9;margin-top:4px;">${new Date(r.timestamp).toLocaleString()}</div>
      </div>

      <div style="padding:16px 4px;">
        <h3 style="font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:6px;">What needs attention</h3>
        <ul style="font-size:13px;color:#444;line-height:1.7;padding-left:18px;">
          ${r.warnings.length ? r.warnings.map(w => `<li>${w}</li>`).join('') : '<li>No specific warnings recorded.</li>'}
        </ul>

        <h3 style="font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:6px;margin-top:20px;">Run metrics</h3>
        <table style="font-size:13px;color:#444;width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 0;">Raw collected</td><td style="text-align:right;">${r.counts.raw}</td></tr>
          <tr><td style="padding:4px 0;">After filtering</td><td style="text-align:right;">${r.counts.filtered}</td></tr>
          <tr><td style="padding:4px 0;">Analyzed</td><td style="text-align:right;">${r.counts.analyzed}</td></tr>
          <tr><td style="padding:4px 0;">AI summary fallbacks</td><td style="text-align:right;">${r.counts.aiFallbacks}</td></tr>
          <tr><td style="padding:4px 0;">Briefing produced</td><td style="text-align:right;">${r.synthesis.ok ? 'Yes (' + r.synthesis.themes + ' themes)' : 'No'}</td></tr>
          <tr><td style="padding:4px 0;">Digest email sent</td><td style="text-align:right;">${r.email.sent ? 'Yes' : 'No'}</td></tr>
        </table>

        <h3 style="font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:6px;margin-top:20px;">Source health</h3>
        <div style="font-size:12px;color:#555;line-height:1.7;">
          ${sourceRows.map(s => `<div>${s}</div>`).join('')}
        </div>

        <p style="font-size:12px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
          This is an automated operator alert, sent only when a run is degraded or failed. Leadership does not receive this message.
        </p>
      </div>
    </div>`;

    const subject = `[${r.status.toUpperCase()}] RE News Pipeline - ${new Date(r.timestamp).toLocaleDateString()}`;
    return { subject, html };
  }
}

module.exports = RunHealth;
