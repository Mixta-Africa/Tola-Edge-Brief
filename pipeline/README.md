# The Tola Edge Brief

A proprietary AI-powered real estate intelligence system built exclusively for Tola Akinsulire, Group Chief Commercial Officer at Mixta Africa.

## Architecture

```
Browser (GitHub Pages)
  └── triggers GitHub Actions via workflow_dispatch
        └── engine.js runs the 6-LLM fallback chain
              └── writes brief_output.json to gh-pages branch
                    └── browser polls and renders brief
```

API keys for all LLM providers are stored as GitHub Secrets — they never touch the browser.
The browser only holds a GitHub PAT (to trigger workflow dispatch) stored in localStorage.

## GitHub Secrets Required

Set these in: **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Description |
|---|---|
| `GROQ_API_KEY` | Groq API key (supports comma-separated multiple keys) |
| `SAMBANOVA_API_KEY` | SambaNova API key |
| `CEREBRAS_API_KEY` | Cerebras API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GEMINI_API_KEY` | Gemini API key |
| `GNEWS_API_KEY` | GNews API key — free tier at gnews.io (100 requests/day) |
| `NEWSAPI_KEY` | NewsAPI key — free tier at newsapi.org (100 requests/day) |
| `GH_DEPLOY_TOKEN` | GitHub PAT with `repo` + `workflow` scope — used by Actions to push to gh-pages |

## Setup Steps

### 1. Create the repository
```bash
git init tola-edge-brief
cd tola-edge-brief
# Copy all files from this package
git add .
git commit -m "feat: initial build"
git remote add origin https://github.com/YOUR-ORG/tola-edge-brief.git
git push -u origin main
```

### 2. Create the gh-pages branch
```bash
git checkout --orphan gh-pages
git rm -rf .
echo '{"request_id":"","status":"idle","brief":null,"generated_at":""}' > brief_output.json
git add brief_output.json
git commit -m "init: gh-pages branch"
git push origin gh-pages
git checkout main
```

### 3. Set GitHub Secrets
Go to your repo → Settings → Secrets and variables → Actions → New repository secret.
Add all secrets from the table above.

### 4. Enable GitHub Pages
Go to: Settings → Pages → Source: Deploy from branch → Branch: `gh-pages` → `/` (root)

### 5. Run the deploy workflow
Go to: Actions → Deploy to GitHub Pages → Run workflow → Run workflow

Your app will be live at: `https://YOUR-ORG.github.io/tola-edge-brief/`

### 6. Configure the app
Open the app URL. A settings modal will appear on first load.
Enter:
- **GitHub PAT**: A Personal Access Token with `workflow` scope (to trigger brief generation)
- **GitHub Owner**: Your org/username (e.g. `mixta-africa`)
- **GitHub Repository**: `tola-edge-brief`

## 6-Provider LLM Fallback Chain

Mirrors the existing `agents.js` architecture exactly:

| Phase | Primary | Fallback Chain |
|---|---|---|
| Intelligence Scan | Groq 8b | → SambaNova → Cerebras → Mistral → OpenRouter → Gemini |
| Synthesis | Groq 70b | → Cerebras → SambaNova → Gemini → Mistral → OpenRouter → Groq 8b |

## Intelligence Domains

| Code | Domain | Priority |
|---|---|---|
| D6 | Market Creation Signals | HIGHEST |
| D1 | Capital & Financing Architecture | HIGH |
| D2 | Land & Regulatory Alpha | HIGH |
| D3 | Demand-Side Market Intelligence | MEDIUM |
| D4 | Partnership & JV Origination Signals | MEDIUM |
| D5 | Geopolitical & Country Risk | THRESHOLD ALERT ONLY |

## Generation Time

~25–45 seconds total:
- Workflow dispatch: ~0.5s
- Actions queue: ~5–10s
- Intelligence scan (Phase A): ~10–15s
- Synthesis (Phase B): ~10–20s
- gh-pages push + CDN propagation: ~5s
- Browser poll detection: up to 5s

## Knowledge Vault

Every generated brief is automatically saved to:
- `gh-pages/vault/TEB_YYYY-MM-DD.json` — full brief JSON
- `gh-pages/data/vault_index.json` — index of all saved briefs

The vault panel in the UI loads the index on startup. Click any entry to load that brief into the reading view.

The Actions engine loads the last 3 vault entries and injects them into the synthesis prompt for pattern recognition and continuity.

## File Structure

```
tola-edge-brief/
├── index.html                        ← Full web app (HTML + CSS + JS)
├── data/
│   └── mixta-context.json            ← Intelligence brain
├── .github/
│   ├── workflows/
│   │   ├── generate-brief.yml        ← Secure proxy workflow
│   │   └── deploy.yml                ← gh-pages deploy workflow
│   └── scripts/
│       └── engine.js                 ← 6-LLM intelligence engine
└── README.md
```

## Phase 2 Roadmap

- **Automated daily delivery**: External scheduler (Make.com / Zapier) calls `workflow_dispatch` at 06:00 WAT
- **Email delivery**: Gmail MCP integration post-synthesis
- **Vector vault**: Supabase pgvector for semantic search across full brief history
- **Weekly / Monthly synthesis briefs**: Consolidated trend briefs for board consumption

## Why Scraped Articles (Not LLM "Web Search")

Free-tier LLMs — Groq, SambaNova, Cerebras, Mistral, OpenRouter — have **no live internet access**. Prompting them to "scan today's news" produces hallucinated articles based on training data from months ago.

The engine uses `GNEWS_API_KEY` and `NEWSAPI_KEY` to fetch **real, dated articles** from live sources, then enriches them with Puppeteer to extract full article text, and only then passes that real content to the 6-LLM chain for analysis. The LLMs analyze real text; they do not generate fake news.
