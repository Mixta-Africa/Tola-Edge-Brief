/**
 * Email Service Module - Google Apps Script Edition
 *
 * Sends emails via Google Apps Script (NOT OAuth2).
 *
 * CHANGES:
 * - Removed emojis (they were corrupting into "??????" through the Apps Script JSON hop).
 * Replaced with clean styled text labels for a minimal, light aesthetic.
 * - Added source-diversified article selection so the digest isn't dominated by one outlet.
 * - Added charset=utf-8 to the POST Content-Type for good measure.
 */

const axios = require('axios');

/**
 * Helper function to strip [0], [1], etc., from LLM generated text.
 */
function cleanLLMText(text) {
  if (!text) return text;
  return text.replace(/\[\d+\]/g, '').trim();
}

/**
 * Render the executive briefing block (the intelligence layer output).
 * This leads the email; the article list below becomes supporting detail.
 */
function renderBriefing(briefing) {
  if (!briefing || !briefing.themes || briefing.themes.length === 0) return '';

  const noveltyStyle = {
    new: { bg: '#e8f5e9', fg: '#1b5e20', label: 'NEW' },
    building: { bg: '#fff8e1', fg: '#8a6d00', label: 'BUILDING' },
    established: { bg: '#eceff1', fg: '#455a64', label: 'ESTABLISHED' },
  };
  const recColor = (rec = '') => {
    const r = rec.toLowerCase();
    if (r.startsWith('act')) return '#c41e3a';
    if (r.startsWith('monitor')) return '#b8860b';
    if (r.startsWith('watch')) return '#5b8db5';
    return '#666';
  };
  const confColor = { high: '#155724', medium: '#8a6d00', low: '#721c24' };

  const themes = briefing.themes.map(t => {
    const nv = noveltyStyle[(t.novelty || 'established').toLowerCase()] || noveltyStyle.established;
    const seen = t.timesSeen && t.timesSeen > 1 ? ` &bull; day ${t.timesSeen}` : '';
    const srcLinks = (t.sourceArticles || [])
      .map(s => `<a href="${s.url || '#'}" target="_blank" style="color:#888;text-decoration:underline;">${s.source || 'source'}</a>`)
      .join(', ');
    const conf = (t.confidence || 'medium').toLowerCase();
    const singleSrc = t.singleSource
      ? `<span style="display:inline-block;background:#fbeaea;color:#a33;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;margin-left:6px;">SINGLE SOURCE</span>`
      : '';

    // Link the theme label to the first source article if available
    const firstUrl = (t.sourceArticles && t.sourceArticles[0]?.url) || '#';
    const labelHtml = firstUrl && firstUrl !== '#'
      ? `<a href="${firstUrl}" target="_blank" style="font-size:15px;font-weight:700;color:#1a1a1a;text-decoration:none;">${t.label || 'Theme'}</a>`
      : `<span style="font-size:15px;font-weight:700;color:#1a1a1a;">${t.label || 'Theme'}</span>`;

    return `
      <div style="background:#ffffff;border:1px solid #eee;border-left:4px solid ${recColor(t.recommendation)};border-radius:4px;padding:16px;margin-bottom:14px;">
        <div style="margin-bottom:8px;">
          ${labelHtml}
          <span style="display:inline-block;background:${nv.bg};color:${nv.fg};font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:8px;">${nv.label}${seen}</span>
          ${singleSrc}
        </div>
        <p style="margin:6px 0;font-size:13px;color:#444;"><strong>What happened:</strong> ${cleanLLMText(t.what_happened || '')}</p>
        <p style="margin:6px 0;font-size:13px;color:#0c5460;background:#eef6fb;border-radius:4px;padding:8px;"><strong>Why it matters to Mixta:</strong> ${cleanLLMText(t.why_it_matters_to_mixta || '')}</p>
        <p style="margin:6px 0;font-size:13px;color:#1a1a1a;"><strong style="color:${recColor(t.recommendation)};">Recommendation:</strong> ${cleanLLMText(t.recommendation || '')}</p>
        <div style="font-size:11px;color:#999;margin-top:8px;">
          Confidence: <strong style="color:${confColor[conf] || '#666'};">${(t.confidence || 'medium').toUpperCase()}</strong>
          ${srcLinks ? ` &bull; Sources: ${srcLinks}` : ''}
        </div>
      </div>`;
  }).join('');

  const watchHits = (briefing.watch_list_hits && briefing.watch_list_hits.length)
    ? `<div style="margin-top:14px;padding:12px;background:#fbf7ef;border:1px solid #f0e6d2;border-radius:6px;font-size:12px;color:#7a5c1e;">
         <strong>Watch-list activity today:</strong> ${briefing.watch_list_hits.join(' &bull; ')}
       </div>`
    : '';

  return `
    <div style="background:#fbfbfb;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:25px;">
      <div style="font-size:11px;letter-spacing:1px;color:#c41e3a;font-weight:700;text-transform:uppercase;margin-bottom:8px;">Executive Briefing</div>
      <p style="font-size:15px;line-height:1.6;color:#1a1a1a;margin:0 0 18px 0;font-weight:500;">${cleanLLMText(briefing.executive_summary || '')}</p>
      ${themes}
      ${watchHits}
    </div>`;
}

/**
 * Generate the email HTML digest.
 *
 * Structure:
 *   1. Header
 *   2. Executive Briefing — full strategic synthesis (themes, why it matters, recommendations)
 *   3. Full Coverage — compact reference index of ALL articles: title + source + link only.
 *      No summaries repeated. The briefing already did the analysis; this section tells
 *      the reader what else was tracked today without restating it.
 *   4. 7-Day Pulse — three data points, kept tight.
 *   5. Footer
 */
function generateEmailHTML(articles, trends, alerts, briefing) {
  // All articles cited in the briefing — we'll mark these differently in the index
  const citedUrls = new Set();
  if (briefing && briefing.themes) {
    briefing.themes.forEach(t => {
      (t.sourceArticles || []).forEach(s => { if (s.url) citedUrls.add(s.url); });
    });
  }

  // Split articles into cited (analysed in briefing) and additional (tracked but not in briefing)
  const citedArticles    = articles.filter(a => citedUrls.has(a.url));
  const additionalArticles = articles.filter(a => !citedUrls.has(a.url));

  const sentimentDot = {
    bullish: { color: '#1b7a4b', label: 'Bullish' },
    bearish: { color: '#c0392b', label: 'Bearish' },
    neutral: { color: '#717a86', label: 'Neutral' },
  };

  const articleRow = (a, dimmed = false) => {
    const s = (a.sentiment || 'neutral').toLowerCase();
    const dot = sentimentDot[s] || sentimentDot.neutral;
    const opacity = dimmed ? 'opacity:0.6;' : '';

    // Build teaser: use the AI summary if real, else fall back to category/topics as context signal
    const rawSummary = a.summary || '';
    const hasSummary = rawSummary && !rawSummary.startsWith('Unable to generate') && rawSummary.trim().length > 20;
    // Trim to one punchy sentence — everything up to first full stop after 40 chars
    let teaser = '';
    if (hasSummary) {
      const firstStop = rawSummary.indexOf('.', 40);
      teaser = firstStop > 0 ? rawSummary.substring(0, firstStop + 1) : rawSummary.substring(0, 120);
    } else if (a.category && a.category !== 'untagged') {
      // Use category + topics as a lightweight signal
      const cats = (a.category || '').replace(/,/g, ' &middot; ');
      teaser = `<em style="color:#aaa;">${cats}</em>`;
    }

    // Mixta relevance note — show indirect if direct is None
    const direct = (a.mixta_relevance?.direct_impact || '');
    const indirect = (a.mixta_relevance?.indirect_impact || '');
    const relevanceNote = (direct && direct !== 'None' && direct !== 'Unable to determine')
      ? direct
      : (indirect && indirect !== 'None' && indirect !== 'Unable to determine')
        ? indirect
        : '';

    return `
      <tr>
        <td style="${opacity}padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
          <a href="${a.url || '#'}" target="_blank"
             style="font-size:13.5px;font-weight:600;color:#1a1a1a;text-decoration:none;line-height:1.4;display:block;">
            ${a.title || 'Untitled'}
          </a>
          ${teaser ? `<div style="font-size:12px;color:#555;margin-top:4px;line-height:1.4;">${teaser}</div>` : ''}
          ${relevanceNote && !dimmed ? `<div style="font-size:11.5px;color:#0c5460;background:#eef6fb;border-radius:3px;padding:3px 8px;margin-top:5px;display:inline-block;">${relevanceNote.substring(0, 100)}</div>` : ''}
          <div style="margin-top:5px;font-size:11px;color:#888;">
            <span style="background:#f0f0f0;color:#444;padding:1px 7px;border-radius:3px;font-weight:600;">${a.source || '?'}</span>
            &nbsp;<span style="color:${dot.color};font-weight:600;">&bull; ${dot.label}</span>
            ${dimmed ? `&nbsp;<span style="color:#bbb;font-style:italic;">— in briefing above</span>` : ''}
          </div>
        </td>
      </tr>`;
  };

  const allRows = [
    ...additionalArticles.map(a => articleRow(a, false)),
    ...citedArticles.map(a => articleRow(a, true)),
  ].join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1a1a1a; background: #f5f5f5; margin: 0; padding: 0; }
        .wrap { max-width: 680px; margin: 0 auto; background: #ffffff; }
        .header { background: linear-gradient(135deg, #c41e3a 0%, #a01829 100%); color: #fff; padding: 28px 32px; }
        .header h1 { margin: 0 0 4px; font-size: 21px; font-weight: 700; letter-spacing: -0.3px; }
        .header p  { margin: 0; font-size: 12px; opacity: 0.85; }
        .section { padding: 24px 32px; }
        .section-label { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #c41e3a; margin-bottom: 14px; }
        .divider { border: none; border-top: 1px solid #eeeeee; margin: 0; }
        .pulse-grid { display: table; width: 100%; border-collapse: collapse; }
        .pulse-cell { display: table-cell; width: 33%; padding: 12px 0; text-align: center; border-right: 1px solid #eee; }
        .pulse-cell:last-child { border-right: none; }
        .pulse-num { font-size: 22px; font-weight: 700; color: #1a1a1a; }
        .pulse-lbl { font-size: 11px; color: #888; margin-top: 2px; }
        .footer { padding: 18px 32px; background: #f9f9f9; border-top: 1px solid #eee; text-align: center; font-size: 11px; color: #bbb; }
      </style>
    </head>
    <body>
    <div class="wrap">

      <!-- HEADER -->
      <div class="header">
        <h1>Nigerian Real Estate Intelligence</h1>
        <p>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
           &nbsp;&bull;&nbsp; Mixta Africa Market Briefing</p>
      </div>

      <!-- EXECUTIVE BRIEFING -->
      <div class="section">
        ${renderBriefing(briefing)}
        ${!briefing || !briefing.themes || !briefing.themes.length
          ? `<p style="color:#888;font-size:13px;">No briefing generated for this run — AI providers were rate-limited. See full coverage below.</p>`
          : ''}
      </div>

      <hr class="divider" />

      <!-- FULL COVERAGE INDEX -->
      <div class="section">
        <div class="section-label">Full Coverage &mdash; ${articles.length} article${articles.length !== 1 ? 's' : ''} tracked today</div>
        ${articles.length === 0
          ? `<p style="color:#aaa;font-size:13px;">No articles collected.</p>`
          : `<table style="width:100%;border-collapse:collapse;">${allRows}</table>`
        }
      </div>

      <hr class="divider" />

      <!-- 7-DAY PULSE -->
      <div class="section" style="padding-top:20px;padding-bottom:20px;">
        <div class="section-label">7-Day Pulse</div>
        <div class="pulse-grid">
          <div class="pulse-cell">
            <div class="pulse-num">${trends['7day']?.articleCount ?? '&mdash;'}</div>
            <div class="pulse-lbl">Articles</div>
          </div>
          <div class="pulse-cell">
            <div class="pulse-num" style="text-transform:capitalize;">${trends['7day']?.averageSentiment || 'Neutral'}</div>
            <div class="pulse-lbl">Sentiment</div>
          </div>
          <div class="pulse-cell">
            <div class="pulse-num" style="font-size:13px;padding-top:4px;">${trends['7day']?.topTopics?.slice(0, 2).map(t => t.topic).join(', ') || '&mdash;'}</div>
            <div class="pulse-lbl">Top Topics</div>
          </div>
        </div>
      </div>

      ${alerts && alerts.length > 0 ? `
        <hr class="divider" />
        <div class="section" style="padding-top:16px;padding-bottom:16px;">
          <div class="section-label">Alerts</div>
          ${alerts.map(a => `
            <div style="background:#fff8e1;border-left:3px solid #f59e0b;padding:10px 12px;margin-bottom:8px;border-radius:4px;font-size:13px;color:#78350f;">
              <strong>${a.type.replace(/_/g,' ').toUpperCase()}:</strong> ${a.message}
            </div>`).join('')}
        </div>`
      : ''}

      <!-- FOOTER -->
      <div class="footer">
        Mixta Africa Market Intelligence &bull; Autonomous Daily Pipeline &bull; GitHub Actions
      </div>
    </div>
    </body>
    </html>
  `;
}

/**
 * Send email via Google Apps Script
 */
async function sendEmail({ to, subject, html }) {
  const appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const appsScriptSecret = process.env.APPS_SCRIPT_SECRET;

  if (!appsScriptUrl || !appsScriptSecret) {
    console.error('[Email] Missing GOOGLE_APPS_SCRIPT_URL or APPS_SCRIPT_SECRET in environment');
    throw new Error('Apps Script credentials missing');
  }

  try {
    console.log(`[Email] Sending to ${to} via Google Apps Script...`);

    const response = await axios.post(
      appsScriptUrl,
      {
        recipients: to,
        subject: subject,
        htmlBody: html,
        secret: appsScriptSecret,
      },
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      }
    );

    if (response.data && response.data.success) {
      console.log(`[Email] Sent successfully`);
      return { success: true, message: 'Email sent via Google Apps Script' };
    } else {
      throw new Error(response.data?.error || 'Unknown error from Apps Script');
    }
  } catch (error) {
    console.error(`[Email] Send failed: ${error.message}`);
    throw error;
  }
}

module.exports = { generateEmailHTML, sendEmail };
