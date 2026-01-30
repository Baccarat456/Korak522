// Discord Server Directory scraper (Cheerio + optional Playwright)
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://top.gg/servers', 'https://disboard.org/servers'],
  maxRequestsPerCrawl = 500,
  useBrowser = false,
  followInternalOnly = true,
  checkInvites = false,
  concurrency = 10,
} = input;

const dataset = await Dataset.open();
const kv = await KeyValueStore.open();
const proxyConfiguration = await Actor.createProxyConfiguration();

// Helpers
function resolveUrl(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return null; }
}
async function checkLink(url, timeout = 15000) {
  const result = { url, status: null, finalUrl: null, error: null };
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', timeout });
    result.status = res.status;
    result.finalUrl = res.url || url;
    if (res.status >= 400) {
      const res2 = await fetch(url, { method: 'GET', redirect: 'follow', timeout });
      result.status = res2.status;
      result.finalUrl = res2.url || result.finalUrl;
    }
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

// Heuristics: extract server metadata from common directory patterns
function parseServerCardCheerio($card, baseUrl) {
  // best-effort extraction for popular directories (top.gg, disboard, discord.me)
  const server = {};
  // name
  server.server_name = $card.find('h3, .card__title, .server-card__name, .media-heading').first().text().trim() || '';
  // invite or link
  let invite = $card.find('a[href*="discord.gg"], a[href*="discord.com/invite"]').first().attr('href') || '';
  if (!invite) {
    // some directories embed invite in data attributes or buttons
    invite = $card.find('[data-invite]').attr('data-invite') || invite;
    if (!invite) {
      const a = $card.find('a').filter((i, el) => {
        const href = $(el).attr('href') || '';
        return href.includes('discord.gg') || href.includes('discord.com/invite') || href.includes('discordapp.com/invite');
      }).first();
      invite = a.attr('href') || '';
    }
  }
  // counts
  const membersText = $card.find('.members, .server-count, .server-member-count').first().text().trim() || '';
  const members_count = membersText.replace(/[^\d]/g, '') || '';
  const onlineText = $card.find('.online, .server-online-count').first().text().trim() || '';
  const online_count = onlineText.replace(/[^\d]/g, '') || '';
  // tags
  const tags = $card.find('.tag, .tags a, .server-tags a').map((i, el) => $(el).text().trim()).get() || [];
  // short description
  const short_description = $card.find('.desc, .server-description, .card__content p').first().text().trim() || '';
  // source url
  let source_url = $card.find('a').first().attr('href') || '';
  if (source_url && !source_url.startsWith('http')) source_url = resolveUrl(baseUrl, source_url) || source_url;

  return {
    server_name,
    invite: invite ? (invite.startsWith('http') ? invite : resolveUrl(baseUrl, invite) || invite) : '',
    members_count,
    online_count,
    tags,
    short_description,
    source_url
  };
}

// Cheerio crawler handler
async function cheerioHandler({ request, $, enqueueLinks, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (cheerio)', { url });

  // Enqueue directory listing links (stay within host's listing pages)
  await enqueueLinks({
    globs: ['**/servers/**', '**/servers*', '**/server/**', '**/guilds/**', '**/list/**'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) { return null; }
      }
      return r;
    }
  });

  // For each likely server card on the page, extract.
  const candidates = $('article, .card, .server-card, .server, .list-item, .media').filter((i, el) => {
    const txt = $(el).text().toLowerCase();
    return txt.includes('discord') || txt.includes('invite') || $(el).find('a[href*="discord"]').length > 0 || $(el).find('.server-tags').length > 0;
  });

  const items = [];
  candidates.each((i, el) => {
    const $card = $(el);
    const item = parseServerCardCheerio($card, url);
    if (item.server_name || item.invite) items.push(item);
  });

  // Fallback: try specific selectors used by top.gg and disboard
  if (items.length === 0) {
    // top.gg style
    $('.serverCard, .server-card').each((i, el) => {
      const $card = $(el);
      const item = parseServerCardCheerio($card, url);
      if (item.server_name || item.invite) items.push(item);
    });
  }

  // Validate invite links if requested (may increase requests)
  if (checkInvites && items.length) {
    for (const it of items) {
      if (it.invite) {
        try {
          const res = await checkLink(it.invite);
          it.invite_status = res.status;
          it.invite_final_url = res.finalUrl || res.url;
          it.invite_error = res.error || null;
        } catch (e) {
          log.warning('Invite check failed', { invite: it.invite, error: e.message });
        }
      }
      it.source_page = url;
      it.extracted_at = new Date().toISOString();
      await dataset.pushData(it);
    }
  } else {
    for (const it of items) {
      it.source_page = url;
      it.extracted_at = new Date().toISOString();
      await dataset.pushData(it);
    }
  }

  // Save items list in KV for this page for later inspection
  try {
    await kv.setValue(`servers/${encodeURIComponent(url)}`, items, { contentType: 'application/json' });
  } catch (e) {
    log.warning('Failed to save page items in KV', { url, error: e.message });
  }
}

// Playwright crawler handler (rendered)
async function playwrightHandler({ page, request, enqueueLinks, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (playwright)', { url });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // Enqueue links (same rules)
  await enqueueLinks({
    globs: ['**/servers/**', '**/servers*', '**/server/**', '**/guilds/**', '**/list/**'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) { return null; }
      }
      return r;
    }
  });

  // Evaluate DOM to extract cards
  const items = await page.evaluate(() => {
    const out = [];
    const containers = Array.from(document.querySelectorAll('article, .card, .server-card, .server, .list-item, .media, .serverCard'));
    for (const c of containers) {
      try {
        const nameEl = c.querySelector('h3, .card__title, .server-card__name, .media-heading, .title');
        const name = nameEl ? nameEl.innerText.trim() : '';
        let invite = '';
        const aInvite = c.querySelector('a[href*="discord.gg"], a[href*="discord.com/invite"], a[href*="discordapp.com/invite"]');
        if (aInvite) invite = aInvite.href;
        const membersEl = c.querySelector('.members, .server-count, .server-member-count');
        const members_count = membersEl ? membersEl.innerText.replace(/[^\d]/g, '') : '';
        const onlineEl = c.querySelector('.online, .server-online-count');
        const online_count = onlineEl ? onlineEl.innerText.replace(/[^\d]/g, '') : '';
        const tagEls = c.querySelectorAll('.tag, .tags a, .server-tags a');
        const tags = Array.from(tagEls).map(t => t.innerText.trim());
        const descEl = c.querySelector('.desc, .server-description, .card__content p');
        const short_description = descEl ? descEl.innerText.trim() : '';
        const linkEl = c.querySelector('a[href]');
        const source_url = linkEl ? linkEl.href : '';
        if (name || invite) out.push({ server_name: name, invite, members_count, online_count, tags, short_description, source_url });
      } catch (e) {
        // ignore per-card errors
      }
    }
    return out;
  });

  // Validate invites if requested
  if (checkInvites && items.length) {
    for (const it of items) {
      if (it.invite) {
        try {
          const res = await fetch(it.invite, { method: 'HEAD', redirect: 'follow' });
          it.invite_status = res.status;
          it.invite_final_url = res.url;
        } catch (e) {
          it.invite_error = e.message;
        }
      }
      it.source_page = url;
      it.extracted_at = new Date().toISOString();
      await dataset.pushData(it);
    }
  } else {
    for (const it of items) {
      it.source_page = url;
      it.extracted_at = new Date().toISOString();
      await dataset.pushData(it);
    }
  }

  try {
    await kv.setValue(`servers/${encodeURIComponent(url)}`, items, { contentType: 'application/json' });
  } catch (e) {
    log.warning('Failed to save page items in KV', { url, error: e.message });
  }
}

// Start crawlers
if (!useBrowser) {
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    async requestHandler(ctx) {
      await cheerioHandler(ctx);
    }
  });

  const startRequests = (startUrls || []).map(u => {
    try {
      const parsed = new URL(u);
      return { url: u, userData: { startHost: parsed.host } };
    } catch (e) {
      return { url: u, userData: {} };
    }
  });

  await crawler.run(startRequests);
} else {
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    maxRequestsPerCrawl,
    async requestHandler(ctx) {
      await playwrightHandler(ctx);
    }
  });

  const startRequests = (startUrls || []).map(u => {
    try {
      const parsed = new URL(u);
      return { url: u, userData: { startHost: parsed.host } };
    } catch (e) {
      return { url: u, userData: {} };
    }
  });

  await crawler.run(startRequests);
}

await Actor.exit();
