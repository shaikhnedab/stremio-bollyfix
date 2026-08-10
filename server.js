const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 7000;

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = { maxResolution: 'any', sources: ['r2', 'fastcloud'], waitForCloudLink: false };
let addonConfig = { ...DEFAULT_CONFIG };

try {
  if (fs.existsSync(CONFIG_FILE)) {
    addonConfig = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  }
} catch (e) { /* ignore */ }

function saveConfig(newConfig) {
  addonConfig = { ...DEFAULT_CONFIG, ...(newConfig || {}) };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(addonConfig, null, 2)); } catch (e) { console.error('config save error:', e.message); }
}

const BASE_URL = 'https://bollyflix.free';
const API_URL = `${BASE_URL}/wp-json/wp/v2`;
const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};
const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};
const ICON_URL = 'https://bollyflix.med/wp-content/uploads/2023/05/Bollyflix-movies.png';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

const cache = (fn, ttl = 30 * 60 * 1000) => {
  const store = new Map();
  return async (...args) => {
    const key = JSON.stringify(args);
    const cached = store.get(key);
    if (cached && Date.now() - cached.time < ttl) return cached.value;
    const value = await fn(...args);
    // don't cache failures/empty results so a transient error doesn't
    // poison the cache for the full TTL
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return value;
    }
    store.set(key, { value, time: Date.now() });
    return value;
  };
};

function extractImdbId(content) {
  if (!content) return null;
  const match = content.match(/imdb\.com\/title\/(tt\d+)/i);
  return match ? match[1] : null;
}

function extractYear(title) {
  if (!title) return null;
  const match = title.match(/\((\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

function extractPosterFromHtml($) {
  return $('meta[property="og:image"]').attr('content') ||
         $('meta[name="twitter:image"]').attr('content') ||
         (() => {
           const bg = $('.poster_parent').css('background-image');
           if (bg) {
             const m = bg.match(/url\(["']?(.*?)["']?\)/);
             if (m) return m[1];
           }
           return '';
         })();
}

function extractPoster(post, $) {
  const poster = extractPosterFromHtml($) ||
                 (post._embedded?.['wp:featuredmedia']?.[0]?.source_url) ||
                 (post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.full?.source_url);
  return poster || '';
}

function extractRating($) {
  const rating = $('#imdb_rating').first().text().trim();
  return rating ? parseFloat(rating) : null;
}

function extractDescription($) {
  return $('#summary').first().text().trim() ||
         $('p:contains("Download")').first().text().trim() ||
         '';
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function cleanTitle(title) {
  if (!title) return '';
  let name = decodeHtmlEntities(title);
  name = name.replace(/^Download\s+/i, '');
  name = name.replace(/\s*\|.*$/, '');
  name = name.replace(/\s*\[[Ss]\d+[^\]]*\]/g, '');
  name = name.replace(/\s*\{[^}]+\}/g, '');
  name = name.replace(/\s*\([^)]*\bseason\b[^)]*\)/gi, '');
  name = name.replace(/\s*(Dual Audio|Multi Audio|WEB Series|TV Series|TV Show|Hindi Dubbed|Season|Movie|English|French|Japanese|Korean|Punjabi|Bengali|Gujarati|Hindi|HDRip|CAMRip|WEBRip|BluRay|WEB-DL|10bit|HQ|Pre-HDRip|Anime)\b.*$/gi, '');
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

function extractLanguages(title) {
  const match = title.match(/\{([^}]+)\}/);
  if (match) {
    return match[1].split(/[-,]/).map(s => s.trim()).filter(Boolean);
  }
  const langMatch = title.match(/\{(Hindi-English|Hindi-English-[A-Za-z]+|[A-Za-z]+-[A-Za-z]+)\}/i);
  if (langMatch) {
    return langMatch[1].split(/[-,]/).map(s => s.trim()).filter(Boolean);
  }
  const langWords = [];
  const langs = ['Hindi', 'English', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Punjabi',
    'Bengali', 'Gujarati', 'Marathi', 'Urdu', 'Malayalam', 'Japanese', 'Korean', 'Chinese',
    'French', 'Italian', 'Spanish', 'German'];
  langs.forEach(lang => {
    if (new RegExp(`\\b${lang}\\b`, 'i').test(title)) langWords.push(lang);
  });
  return langWords.length ? langWords : [];
}

function extractGenres($) {
  const genres = [];
  const scriptText = $('script[type="application/ld+json"]').first().text();
  if (scriptText) {
    try {
      const jsonLd = JSON.parse(scriptText);
      const article = jsonLd['@graph']?.find(g => g['@type'] === 'Article');
      if (article?.articleSection) {
        const sections = Array.isArray(article.articleSection) ? article.articleSection : [article.articleSection];
        const exclude = ['1080p MOVIES','480p MOVIES','720p MOVIES','300MB MOVIES','500MB MOVIES',
          '700MB MOVIES','900MB MOVIES','1GB MOVIES','HDTC','HDRIP','CAMRIP','WEBRip',
          'WEB-DL','DUAL AUDIO','HINDI DUBBED','MULTI AUDIO','Bollywood','WEB SERIES','WEB'];
        sections.forEach(s => { if (s && !exclude.includes(s)) genres.push(s); });
      }
    } catch (e) { /* ignore */ }
  }
  return genres;
}

function extractCast($) {
  const cast = [];
  $('#imdb_general b:contains("Stars:")').parent().find('a').each((_, el) => {
    const name = $(el).text().trim();
    if (name && name !== 'Stars') cast.push({ name, role: 'Actor' });
  });
  return cast;
}

function extractDirector($) {
  const text = $('#imdb_general b:contains("Director:")').parent().find('a').first().text().trim();
  return text || '';
}

function isSeries(title, content, classList) {
  const lowerTitle = (title || '').toLowerCase();
  const lowerContent = (content || '').toLowerCase();
  const lowerClass = Array.isArray(classList) ? classList.join(' ').toLowerCase() : '';
  return lowerTitle.includes('season') ||
         lowerTitle.includes('web series') ||
         lowerTitle.includes('tv series') ||
         lowerTitle.includes('episode') ||
         lowerContent.includes('season ') ||
         lowerClass.includes('web-series') ||
         lowerClass.includes('tv-show') ||
         lowerClass.includes('ongoing');
}

function extractSeasonEpisode(title) {
  const seasonRange = title.match(/[Ss]eason\s*(\d+)\s*[-–]\s*(\d+)/);
  const season = title.match(/[Ss]eason\s*(\d+)/);
  const sxxExx = title.match(/[Ss](\d+)[Ee](\d+)/i);

  let s = null, e = null, lastE = null;
  if (season) s = parseInt(season[1], 10);
  if (seasonRange) { s = parseInt(seasonRange[1], 10); lastE = parseInt(seasonRange[2], 10); }
  if (sxxExx) { s = parseInt(sxxExx[1], 10); e = parseInt(sxxExx[2], 10); }
  return { season: s, episode: e, lastEpisode: lastE };
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: HEADERS_HTML });
    if (!res.ok) return null;
    return cheerio.load(await res.text());
  } catch (err) {
    console.error(`Error fetching ${url}:`, err.message);
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS_JSON });
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    console.error(`Error fetching ${url}:`, err.message);
    return null;
  }
}

const fetchJsonCached = cache(fetchJson, 30 * 60 * 1000);
const fetchHtmlCached = cache(fetchHtml, 30 * 60 * 1000);

function fetchHtmlViaCurl(url) {
  try {
    const html = execSync(`curl -s -L --max-time 30 "${url}" -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'`, {
      encoding: 'utf8',
      timeout: 35000,
      maxBuffer: 1024 * 1024 * 5
    });
    return html;
  } catch (err) {
    console.error(`curl error for ${url}:`, err.message);
    return null;
  }
}

const fetchCurlCached = cache(fetchHtmlViaCurl, 60 * 1000);

function extractResolution(text) {
  if (!text) return null;
  const m = text.match(/\b(2160p|4K|1440p|2K|1080p|720p|480p|360p)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function extractQuality(text) {
  if (!text) return null;
  const m = text.match(/\b(Pre-HDRip|HDRip|CAMRip|HDTC|WEB-DL|WEBRip|BluRay|DVDRip|BD-Remux|HQ|HD|WEB)\b/i);
  return m ? m[1] : null;
}

function extractHDR(text) {
  if (!text) return 'SDR';
  if (/\b(HDR10\+|HDR10|Dolby Vision|DoVi|HLG|PQ10)\b/i.test(text) || /\bDV\b/.test(text)) return 'HDR';
  return 'SDR';
}

async function resolveFastCloudUrl(cloudUrl, waitForCloudLink) {
  try {
    const html = await fetchHtmlViaCurl(cloudUrl);
    if (!html) return null;
    let found = extractCloudDl(html);
    if (found) return found;

    // No Cloud Resume button yet -> optionally try "Generate Cloud Link" (action=cloud)
    const wait = typeof waitForCloudLink === 'boolean' ? waitForCloudLink : addonConfig.waitForCloudLink;
    if (wait) {
      const generated = await generateCloudLink(cloudUrl);
      if (generated) return generated;
    }

    return null;
  } catch (err) {
    console.error('Error resolving fast cloud:', err.message);
    return null;
  }
}

function encodeCloudDl(raw) {
  const slashIdx = raw.indexOf('/', 8);
  if (slashIdx < 0) return null;
  const host = raw.slice(0, slashIdx);
  const path = raw.slice(slashIdx);
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash < 0) return null;
  const tokenPart = path.slice(0, lastSlash);
  const origName = path.slice(lastSlash + 1).split('?')[0];
  const archived = /\.(zip|rar|7z)$/i.test(origName);
  const filename = origName.replace(/\.(zip|rar|7z)$/i, '');
  const encoded = host + tokenPart + '/' + encodeURIComponent(filename);
  return { url: encoded, filename, archived };
}

function extractCloudDl(html) {
  if (!html) return null;
  const m = html.match(/href\s*=\s*["'](https:\/\/cloud-dl[^"']+)["']/) ||
            html.match(/https:\/\/cloud-dl\.\w[\w.]*\.workers\.dev\/[^"']+/);
  if (!m) return null;
  const encoded = encodeCloudDl(m[1] || m[0]);
  if (!encoded) return null;
  return encoded;
}

// "Generate Cloud Link": POST action=cloud to the /cloud/ page, then fetch the
// returned page and wait (bounded poll) until the Cloud Resume Download button
// appears. Verified the POST works without a turnstile token.
async function generateCloudLink(cloudUrl) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let html;
  try { html = await fetchHtmlViaCurl(cloudUrl); } catch (e) { return null; }
  const key = (html.match(/formData\.append\("key", "([^"]+)"/) || [])[1];
  if (!key) return null;
  const u = new URL(cloudUrl);
  const resp = execSync(`curl -s --max-time 20 -X POST "https://${u.hostname}${u.pathname}" -H "x-token: ${u.hostname}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --data-urlencode "action=cloud" --data-urlencode "key=${key}" --data-urlencode "action_token="`, {
    encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024
  });
  let data;
  try { data = JSON.parse(resp); } catch (e) { return null; }
  const target = data.visit_url || data.url;
  if (!target || typeof target !== 'string') return null;
  const tUrl = target.startsWith('/') ? `https://${u.hostname}${target}` : target;

  // wait for the file to be prepared, then grab the Cloud Resume link
  const deadline = Date.now() + 15000; // bounded: don't block the response too long
  while (Date.now() < deadline) {
    const page = await fetchHtmlViaCurl(tUrl);
    const resume = page ? extractCloudDl(page) : null;
    if (resume) return resume;
    await sleep(5000);
  }
  return null;
}

const resolveFastCloudCached = cache(resolveFastCloudUrl, 20 * 1000);

const fetchCloudPageCached = cache(fetchHtmlViaCurl, 60 * 1000);

// "Generate Quick Link" - POST action=quick. Returns a quick.cloudpaglu.site
// URL that serves the raw video (unzipped) when the .zip extension is stripped.
// Used internally to make zip-stored mirrors streamable.
async function resolveFastCloudQuick(cloudUrl) {
  try {
    const html = await fetchCloudPageCached(cloudUrl);
    if (!html) return null;
    const key = (html.match(/formData\.append\("key", "([^"]+)"/) || [])[1];
    if (!key) return null;
    const u = new URL(cloudUrl);
    const resp = execSync(`curl -s --max-time 20 -X POST "https://${u.hostname}${u.pathname}" -H "x-token: ${u.hostname}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --data-urlencode "action=quick" --data-urlencode "key=${key}" --data-urlencode "action_token="`, {
      encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024
    });
    let data;
    try { data = JSON.parse(resp); } catch (e) { return null; }
    const quickUrl = data?.url?.Quick_url || data?.Quick_url || data?.url?.url;
    if (!quickUrl || typeof quickUrl !== 'string') return null;
    const encoded = encodeCloudDl(quickUrl);
    if (!encoded) return null;
    return { url: encoded.url, filename: encoded.filename, archived: false };
  } catch (err) {
    console.error('Error resolving quick link:', err.message);
    return null;
  }
}

function extractSeriesDownloadLinks($) {
  const links = [];
  const seen = new Set();
  const add = (href) => {
    if (href && !seen.has(href)) { seen.add(href); links.push(href); }
  };
  $('a[href*="fxlinks.rest"]').each((_, el) => add($(el).attr('href')));
  $('a[href*="linksmod.top/view/"]').each((_, el) => add($(el).attr('href')));
  return links;
}

async function parseFxlinksDownloadPage(pageUrl) {
  try {
    const html = await fetchHtmlViaCurl(pageUrl);
    if (!html) return null;

    const seasonMatch = html.match(/"headline":"[^"]*Season\s*(\d+)/i) ||
                        html.match(/Season\s*(\d+)/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    const resolution = extractResolution(html.match(/"headline":"([^"]+)"/) ? html.match(/"headline":"([^"]+)"/)[1] : html);

    const $ = cheerio.load(html);
    const episodes = [];
    let zipUrl = null;
    let zipLabel = 'Season Zip';

    $('a[href*="fastdlserver.site"]').each((_, el) => {
      const url = $(el).attr('href');
      const text = $(el).text().trim();
      const e = text.match(/Episode\s*(\d+)/i);
      if (e) {
        episodes.push({ season, episode: parseInt(e[1], 10), url });
      } else if (/zip/i.test(text)) {
        zipUrl = url;
        zipLabel = text;
      }
    });

    return { season, resolution, episodes, zipUrl, zipLabel, pageUrl };
  } catch (err) {
    console.error('Error parsing fxlinks page:', err.message);
    return null;
  }
}

const fetchFxlinksCached = cache(parseFxlinksDownloadPage, 60 * 1000);

const RES_RANK = { '2160p': 4, '4k': 4, '1440p': 3, '1080p': 3, '720p': 2, '480p': 1, '360p': 0 };

async function getSeriesEpisodes(downloadUrls) {
  const pages = [];
  const seenPage = new Set();
  for (const u of downloadUrls || []) {
    if (seenPage.has(u)) continue;
    seenPage.add(u);
    const p = await fetchFxlinksCached(u);
    if (p) pages.push(p);
  }

  const byKey = new Map();
  pages.forEach(p => {
    (p.episodes || []).forEach(e => {
      const key = `${e.season || 0}-${e.episode}`;
      if (!byKey.has(key)) byKey.set(key, e);
    });
  });

  const episodes = [...byKey.values()].sort((a, b) =>
    (a.season - b.season) || (a.episode - b.episode));

  const seasons = [...new Set(episodes.map(e => e.season).filter(Boolean))].sort((a, b) => a - b);

  const zips = pages.filter(p => p.zipUrl).map(p => ({ season: p.season, url: p.zipUrl, label: p.zipLabel }));
  const seasonZips = new Map();
  zips.forEach(z => { if (z.season && !seasonZips.has(z.season)) seasonZips.set(z.season, z); });

  // Collect all mirrors per (season, episode), sorted by resolution desc
  const mirrorsByKey = new Map();
  pages.forEach(p => {
    (p.episodes || []).forEach(e => {
      const key = `${e.season || 0}-${e.episode}`;
      if (!mirrorsByKey.has(key)) mirrorsByKey.set(key, []);
      mirrorsByKey.get(key).push({ season: e.season, episode: e.episode, url: e.url, resolution: p.resolution || null });
    });
  });
  mirrorsByKey.forEach(arr => {
    arr.sort((a, b) => (RES_RANK[b.resolution || ''] || -1) - (RES_RANK[a.resolution || ''] || -1));
  });

  const episodeMirrors = [...mirrorsByKey.entries()].map(([key, mirrors]) => {
    const [s, e] = key.split('-');
    return { season: parseInt(s, 10), episode: parseInt(e, 10), mirrors };
  }).sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

  return { episodes, seasons, seasonZips, pages, episodeMirrors };
}

function isPlayableResult(r) {
  if (r.archived) return false;
  const fn = (r.filename || '').toLowerCase();
  if (/\.(zip|rar|7z|cbr|cbz)$/.test(fn)) return false;
  return true;
}

// quick.cloudpaglu.site ignores Range requests (serves full 200) -> can't
// resume/seek. Resumable links (R2, cloud-dl) send Accept-Ranges: bytes.
function isResumableResult(r) {
  const host = r.url && r.url.split('/')[2] || '';
  return !/cloudpaglu\.site$/i.test(host);
}

async function resolveFastdlServer(fastdlUrl, waitForCloudLink) {
  try {
    const html = await fetchCurlCached(fastdlUrl);
    if (!html) return null;

    const $ = cheerio.load(html);
    const results = [];

    let filename = '';
    const h5 = $('h5').first().text().trim();
    if (h5) {
      filename = h5.replace(/\s*\[\s*[\d.]+\s*(MB|GB|TB)\s*\]\s*$/i, '').trim();
    } else {
      filename = $('title').text().replace(/^GDFlix\s*\|\s*/, '').trim();
    }

    // page filename tells whether the stored file is zipped
    const pageArchived = /\.(zip|rar|7z)$/i.test(filename);

    // Find direct R2 link (pub-*.r2.dev) - this is directly streamable
    const r2Link = $('a[href*="r2.dev"]').filter((_, el) => $(el).attr('href')?.includes('pub-')).attr('href') ||
                   $('a[href*="pub-"][href*="r2.dev"]').attr('href');

    if (r2Link) {
      results.push({ type: 'stream', url: r2Link, filename, archived: pageArchived });
    } else {
      // Fallback: decode fastcdn-dl.pages.dev proxy URL to get the R2 URL
      const cloudR2Link = $('a:contains("CLOUD DOWNLOAD [R2]")').attr('href') ||
                          $('a:contains("CLOUD DOWNLOAD")').attr('href');
      if (cloudR2Link && cloudR2Link.includes('fastcdn-dl.pages.dev')) {
        const urlMatch = cloudR2Link.match(/[?&]url=([^&]+)/);
        if (urlMatch) {
          const decoded = decodeURIComponent(urlMatch[1]);
          if (decoded.includes('r2.dev')) {
            results.push({ type: 'stream', url: decoded, filename, archived: pageArchived });
          }
        }
      }
    }

    // Find FAST CLOUD / ZIPDISK link (/cloud/...)
    const fastCloudEl = $('a:contains("FAST CLOUD")').first();
    if (fastCloudEl.length) {
      const cloudUrl = new URL(fastCloudEl.attr('href'), 'https://new3.gdflix.io').href;
      // Cloud Resume Download (cloud-dl). Auto-triggers "Generate Cloud Link"
      // and waits for the Cloud Resume button if needed.
      let fcStream = await resolveFastCloudCached(cloudUrl, waitForCloudLink);
      if (!fcStream) fcStream = await resolveFastCloudUrl(cloudUrl, waitForCloudLink);
      if (fcStream) {
        // only keep resumable (seeking-capable) links
        if (!isResumableResult(fcStream)) fcStream = null;
      }
      if (fcStream) {
        results.push({
          type: 'stream',
          url: fcStream.url,
          filename: fcStream.filename || filename,
          archived: fcStream.archived || false
        });
      } else {
        results.push({ type: 'external', url: cloudUrl, filename });
      }
    }
    return results.length ? results : null;
  } catch (err) {
    console.error('Error resolving fastdlserver:', err.message);
    return null;
  }
}

function buildStreamCard(r, movieName, season, episode, ser, preferResolution) {
  const filename = r.filename || '';
  const resolution = preferResolution || extractResolution(filename) || 'Unknown';
  const quality = extractQuality(filename) || 'Unknown';
  const audioList = extractLanguages(filename);
  const audio = audioList.length ? audioList.join(' / ') : 'Unknown';
  const source = r.url && r.url.includes('r2.dev') ? 'R2' : 'FAST CLOUD';
  const hdr = extractHDR(filename);

  let displayName = movieName;
  if (ser && (season || episode)) {
    displayName += ` - S${String(season || 1).padStart(2, '0')}${episode ? 'E' + String(episode).padStart(2, '0') : ''}`;
  }

  const description = [
    `Resolution: ${resolution}`,
    `Quality: ${quality}`,
    `Audio: ${audio}`,
    `Color: ${hdr}`
  ].join('\n');

  let nameTag = `[${source}]`;
  if (hdr === 'HDR') nameTag += ' [HDR]';

  return {
    name: `${nameTag} ${displayName}`,
    description
  };
}

function getWpPost(postId) {
  return fetchJsonCached(`${API_URL}/posts/${postId}?_embed=1`);
}

async function getBollyflixHtmlPage(post) {
  if (!post?.link) return null;
  const cached = await fetchHtmlCached(post.link);
  if (cached) return cached;
  if (!post.content?.rendered) return null;
  return cheerio.load(post.content.rendered);
}

function getRecentPosts(page = 1, perPage = 20) {
  return fetchJsonCached(`${API_URL}/posts?per_page=${perPage}&page=${page}&_embed=1&orderby=date&order=desc`);
}

function searchWpPosts(query, page = 1, perPage = 20) {
  return fetchJsonCached(`${API_URL}/posts?search=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&_embed=1&orderby=relevance&order=desc`);
}

function searchByImdbId(imdbId) {
  return fetchJsonCached(`${API_URL}/posts?search=${encodeURIComponent(imdbId)}&per_page=5&_embed=1`);
}

function extractDownloadLinksFromHtml($) {
  const links = [];
  const seen = new Set();

  const addLink = (url, name) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      links.push({ url, name: name || 'Download Link' });
    }
  };

  $('.dl, .btnn, .button-download-links, .maxbutton').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('linksmod.top') && !href.includes('fxlinks.rest')) {
      addLink(href, $(el).text().trim() || 'Download');
    }
  });

  $('a[href*="fastdlserver.site"]').each((_, el) => {
    addLink($(el).attr('href'), 'Google Drive');
  });

  links.sort((a, b) => {
    if (a.url.includes('fastdlserver')) return -1;
    if (b.url.includes('fastdlserver')) return 1;
    return 0;
  });

  return links;
}



function generateMetaPreview(post) {
  const $ = cheerio.load(post.content.rendered || '');
  const title = post.title.rendered || '';
  return {
    id: `bf:${post.id}`,
    type: 'movie',
    name: cleanTitle(title) || title,
    year: extractYear(title),
    poster: extractPoster(post, $),
    posterShape: 'poster'
  };
}

function generateSeriesMetaPreview(post) {
  const $ = cheerio.load(post.content.rendered || '');
  const title = post.title.rendered || '';
  const { season } = extractSeasonEpisode(title);
  return {
    id: season ? `bf:${post.id}:${season}` : `bf:${post.id}`,
    type: 'series',
    name: cleanTitle(title) || title,
    year: extractYear(title),
    poster: extractPoster(post, $),
    posterShape: 'poster'
  };
}

function parseExtra(s) {
  if (!s) return {};
  const result = {};
  s.split('&').forEach(pair => {
    const parts = pair.split('=');
    if (parts.length >= 2) {
      result[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1]);
    }
  });
  return result;
}

function stripJsonSuffix(val) {
  return val ? val.replace(/\.json$/, '') : val;
}

const catalogHandler = async (req, res) => {
  const type = req.params.type;
  const id = stripJsonSuffix(req.params.id);
  const extra = stripJsonSuffix(req.params.extra);
  const extraParams = parseExtra(extra || '');
  const searchQuery = extraParams.search || req.query.search;
  const perPage = 20;

  try {
    let posts = [];

    if (searchQuery) {
      posts = await searchWpPosts(searchQuery, 1, perPage);
    } else if (id === 'bollyflix_movies' && type === 'movie') {
      posts = await getRecentPosts(1, perPage);
    } else if (id === 'bollyflix_series' && type === 'series') {
      const allPosts = await getRecentPosts(1, 50);
      if (Array.isArray(allPosts)) {
        posts = allPosts.filter(p => isSeries(
          p.title?.rendered,
          p.content?.rendered,
          p.class_list || []
        ));
      }
    }

    if (!Array.isArray(posts)) posts = [];

    const metas = posts.map(post => {
      const ser = isSeries(post.title?.rendered, post.content?.rendered, post.class_list || []);
      if (type === 'series') return generateSeriesMetaPreview(post);
      if (type === 'movie' && ser) return null;
      if (type === 'movie' || !ser) return generateMetaPreview(post);
      return generateSeriesMetaPreview(post);
    }).filter(m => m !== null);

    res.json({ metas, hasMore: metas.length >= perPage });
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
};

const metaHandler = async (req, res) => {
  const type = req.params.type;
  const rawId = req.params.id;
  const id = stripJsonSuffix(rawId);

  try {
    let bollyflixId = id;
    let season = null;

    if (id.startsWith('bf:')) {
      const parts = id.split(':');
      bollyflixId = parts[1];
      if (parts[2]) season = parseInt(parts[2], 10);
    } else if (id.startsWith('tt')) {
      const imdb = id.split(':')[0];
      const posts = await searchByImdbId(imdb);
      if (!Array.isArray(posts) || posts.length === 0) {
        return res.json({ meta: null });
      }
      bollyflixId = posts[0].id;
      const parts = id.split(':');
      if (parts[1]) season = parseInt(parts[1], 10);
    }

    const post = await getWpPost(bollyflixId);
    if (!post) return res.json({ meta: null });

    const $ = await getBollyflixHtmlPage(post);
    const title = decodeHtmlEntities(post.title?.rendered || '');
    const ser = isSeries(title, post.content?.rendered, post.class_list || []);
    const contentType = type === 'series' || ser ? 'series' : 'movie';
    const { season: sNum } = extractSeasonEpisode(title);

    let videos = null;
    if (contentType === 'series') {
      const dlLinks = extractSeriesDownloadLinks($);
      const data = await getSeriesEpisodes(dlLinks);
      const pad = (n) => String(n).padStart(2, '0');
      const maxSeasonKnown = data.seasons.length ? Math.max(...data.seasons) : null;
      const vidForSeason = (s) => data.episodes.filter(e => e.season === s).map(e => ({
        id: `${e.season}:${e.episode}`,
        title: `${cleanTitle(title) || title} S${pad(e.season)}E${pad(e.episode)}`,
        season: e.season,
        number: e.episode,
        released: post.date || undefined
      }));
      if (season && data.seasons.includes(season)) {
        const hasZip = data.seasonZips.has(season);
        videos = vidForSeason(season);
        if (!videos.length && hasZip) {
          videos = [{ id: `${season}:1`, title: `${cleanTitle(title) || title} S${pad(season)}`, season, number: 1, released: post.date || undefined }];
        }
      }
      numSeason = maxSeasonKnown && maxSeasonKnown > (sNum || 0) ? maxSeasonKnown : (sNum || 0);
    }

    const resultMeta = {
      id: id.startsWith('bf:') ? (contentType === 'series' && season ? `bf:${post.id}:${season}` : `bf:${post.id}`) : `bf:${post.id}`,
      type: contentType,
      name: cleanTitle(title) || title,
      year: extractYear(title),
      poster: extractPoster(post, $),
      posterShape: 'poster',
      description: extractDescription($),
      genres: extractGenres($),
      cast: extractCast($),
      ...(extractDirector($) && { director: [{ name: extractDirector($), role: 'Director' }] }),
      ...(extractRating($) && { rating: { source: 'IMDb', probability: extractRating($) / 10 } }),
      ...(extractLanguages(title)[0] && { language: extractLanguages(title)[0] }),
      ...(extractImdbId(post.content?.rendered) && { imdbId: extractImdbId(post.content?.rendered) }),
      ...(contentType === 'series' && numSeason && { numSeason }),
      ...(videos && { videos })
    };

    res.json({ meta: resultMeta });
  } catch (err) {
    console.error('Meta error:', err.message);
    res.status(500).json({ error: 'Failed to fetch meta' });
  }
};

const streamHandler = async (req, res) => {
  const id = stripJsonSuffix(req.params.id);

  try {
    const idParts = id.split(':');
    let bollyflixId = id;
    let reqSeason = null;
    let reqEpisode = null;

    if (id.startsWith('bf:')) {
      bollyflixId = idParts[1];
      if (idParts[2]) reqSeason = parseInt(idParts[2], 10);
      if (idParts[3]) reqEpisode = parseInt(idParts[3], 10);
    } else if (id.startsWith('tt')) {
      // Stremio sends tide2 like tt9140554:1:1 (imdb:season:episode);
      // split so we search by the plain imdb id only
      const imdb = idParts[0];
      const posts = await searchByImdbId(imdb);
      if (!Array.isArray(posts) || posts.length === 0) {
        return res.json({ streams: [] });
      }
      bollyflixId = posts[0].id;
      if (idParts[1]) reqSeason = parseInt(idParts[1], 10);
      if (idParts[2]) reqEpisode = parseInt(idParts[2], 10);
    }

    const post = await getWpPost(bollyflixId);
    if (!post) return res.json({ streams: [] });

    const $ = await getBollyflixHtmlPage(post);
    const rawTitle = decodeHtmlEntities(post.title?.rendered || '');
    const ser = isSeries(rawTitle, post.content?.rendered, post.class_list || []);
    const { season: titleSeason, episode: titleEpisode } = extractSeasonEpisode(rawTitle);
    const movieName = cleanTitle(rawTitle) || rawTitle;
    const streams = [];
    const cfg = req.addonConfig || addonConfig;

    const pushStream = (r, season, episode, resolution) => {
      const card = buildStreamCard(r, movieName, season, episode, ser, resolution);
      streams.push({
        name: card.name,
        description: card.description,
        url: r.url,
        icon: ICON_URL,
        ...(ser ? { behaviorHints: { bingeGroup: `bf:${post.id}` } } : {})
      });
    };

    const sourceAllowed = (r) => {
      const sources = cfg.sources || DEFAULT_CONFIG.sources;
      if (r.url && r.url.includes('r2.dev')) return sources.includes('r2');
      return sources.includes('fastcloud');
    };

    const minResRank = cfg.minResolution && cfg.minResolution !== 'any'
      ? (RES_RANK[cfg.minResolution.toLowerCase()] ?? 0) : 0;
    const maxResRank = cfg.maxResolution && cfg.maxResolution !== 'any'
      ? (RES_RANK[cfg.maxResolution.toLowerCase()] ?? 99) : 99;

    const allowedByConfig = (r, resolution) => {
      if (!sourceAllowed(r)) return false;
      const raw = (resolution || '').toLowerCase() || (r.filename || '').toLowerCase();
      const resVal = extractResolution(raw) || '';
      const rank = RES_RANK[resVal] ?? -1;
      return rank >= minResRank && rank <= maxResRank;
    };

    const waitForCloudLink = typeof cfg.waitForCloudLink === 'boolean' ? cfg.waitForCloudLink : addonConfig.waitForCloudLink;

    const addResolvedStreams = async (fastdlUrl, season, episode, resolution) => {
      const resolved = await resolveFastdlServer(fastdlUrl, waitForCloudLink);
      if (!resolved) return;
      for (const r of resolved) {
        if (r.type !== 'stream') continue;
        if (!isPlayableResult(r)) continue;
        if (!isResumableResult(r)) continue;
        if (!allowedByConfig(r, resolution)) continue;
        pushStream(r, season, episode, resolution);
      }
    };

    if (ser) {
      // Series flow: Download Links (fxlinks/linksmod) -> season -> episodes -> mirrors -> r2/fast cloud
      const dlLinks = extractSeriesDownloadLinks($);
      const data = await getSeriesEpisodes(dlLinks);

      let candidates = data.episodeMirrors;
      if (reqSeason) candidates = candidates.filter(e => e.season === reqSeason);
      if (reqEpisode) candidates = candidates.filter(e => e.episode === reqEpisode);

      // limit concurrency to avoid gdflix rate-limiting
      let idx = 0;
      const workers = Array.from({ length: Math.max(1, Math.min(3, candidates.length)) }, async () => {
        while (idx < candidates.length) {
          const epState = candidates[idx++];
          const results = await Promise.all(epState.mirrors.map(m => resolveFastdlServer(m.url, waitForCloudLink)));
          // show every mirror that resolves to a playable stream (all resolutions)
          const seen = new Set();
          for (let i = 0; i < epState.mirrors.length; i++) {
            const rs = results[i] || [];
            const r = rs.find(x => x.type === 'stream' && isPlayableResult(x) && isResumableResult(x) && allowedByConfig(x, epState.mirrors[i].resolution));
            if (!r || seen.has(r.url)) continue;
            seen.add(r.url);
            pushStream(r, epState.season, epState.episode, epState.mirrors[i].resolution);
          }
        }
      });
      await Promise.all(workers);

      // Fall back to the season zip when a whole season is requested and no episode streams resolved
      if (streams.length === 0 && reqSeason && !reqEpisode) {
        const zip = data.seasonZips.get(reqSeason);
        if (zip) await addResolvedStreams(zip.url, zip.season, null);
      }
    } else {
      // Movie flow: fastdlserver links on the post page
      const downloadLinks = extractDownloadLinksFromHtml($);
      await Promise.all(downloadLinks
        .filter(link => link.url.includes('fastdlserver.site'))
        .map(link => addResolvedStreams(link.url, titleSeason, titleEpisode)));
    }

    if (streams.length === 0) {
      streams.push({
        name: 'BollyFlix',
        description: movieName + '\nClick to download from BollyFlix',
        externalUrl: post.link,
        icon: ICON_URL
      });
    }

    res.json({ streams });
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
};

function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConfig(token) {
  try {
    const json = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const cfg = JSON.parse(json);
    return (cfg && typeof cfg === 'object') ? cfg : null;
  } catch (e) { return null; }
}

// URL-token config (MovieBox style): /<base64config>/manifest.json etc.
app.use((req, res, next) => {
  const m = req.path.match(/^\/([A-Za-z0-9_-]{10,})\/(.*)$/);
  if (m) {
    const cfg = decodeConfig(m[1]);
    if (cfg) {
      req.addonConfig = { ...addonConfig, ...cfg };
      req.url = '/' + m[2];
      next();
      return;
    }
  }
  next();
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});
app.use('/configure', express.static(path.join(__dirname, 'web')));

app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

app.use((req, res, next) => {
  if (req.path.startsWith('/catalog') || req.path.startsWith('/stream') || req.path.startsWith('/meta')) {
    console.error(`[req] ${req.method} ${req.path} from ${req.headers['user-agent'] || '?'}`);
  }
  next();
});

app.get(['/catalog/:type/:id', '/catalog/:type/:id.json'], catalogHandler);
app.get(['/catalog/:type/:id/:extra', '/catalog/:type/:id/:extra.json'], catalogHandler);

app.get(['/meta/:type/:id', '/meta/:type/:id.json'], metaHandler);

app.get(['/stream/:type/:id', '/stream/:type/:id.json'], streamHandler);

app.get('/configuration', (req, res) => {
  res.json(addonConfig);
});

app.post('/configuration', (req, res) => {
  const body = req.body || {};
  const cfg = {};
  if (body.maxResolution) cfg.maxResolution = body.maxResolution;
  if (Array.isArray(body.sources)) {
    cfg.sources = body.sources;
  } else if (typeof body.sources === 'string') {
    cfg.sources = body.sources.split(',').map(s => s.trim()).filter(Boolean);
  } else if (body['sources[]']) {
    cfg.sources = Array.isArray(body['sources[]']) ? body['sources[]'] : [body['sources[]']];
  }
  cfg.waitForCloudLink = body.waitForCloudLink === true || body.waitForCloudLink === 'true' || body.waitForCloudLink === 'on';
  saveConfig(cfg);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`BollyFlix Stremio addon running on port ${PORT}`);
  console.log(`Install URL: http://localhost:${PORT}/manifest.json`);
});

module.exports = app;
