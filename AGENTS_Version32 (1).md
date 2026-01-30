## What are Apify Actors?

- Actors are serverless cloud programs packaged as Docker images that accept JSON input, perform an action, and produce structured JSON output.

Discord Server Directory scraper notes
- This Actor is designed to crawl *public* directory/listing websites (top.gg, disboard.org, discord.me, etc.) and extract publicly available server metadata:
  - server name, invite link, member count, online count, tags, short description, source listing URL.
- Legal & ToS:
  - Do NOT attempt to join or scrape private servers, bypass invite protections, or collect private user data.
  - Many directories prohibit scraping in their Terms of Service; review each site's ToS and robots.txt before running large crawls.
  - For anything that requires login or protected endpoints, obtain permission or use official APIs.
- Use `useBrowser=true` for sites that render content client-side (slower but more robust).
- `checkInvites` enables validation of invite links (it increases request count).
- The scraper stores per-item records in the default Dataset and page-level lists to the Key-Value Store (key: `servers/<encoded-page-url>`).

Quick local setup (copy/paste)
1) Create directory and open it:
- mkdir discord-server-directory-scraper
- cd discord-server-directory-scraper

2) Create files:
- Paste files above into corresponding paths (.actor/*, src/main.js, package.json, Dockerfile, AGENTS.md).

3) Install dependencies:
- npm install

4) Run Actor locally:
- apify run

Recommended improvements (pick one)
- Add site-specific parsers for top.gg, disboard, discord.me to make extraction more accurate per site.
- Add rate-limiting per domain and polite delays (avoid IP bans).
- Add invite-discovery: follow server detail pages to capture canonical invite (requires caution & respect ToS).
- Add CSV export, deduplication of servers across sources, and geotagging (if available).
- Add scheduled runs and incremental updates (store last-seen invite/status in KV to detect changes).

Which improvement would you like me to implement next?