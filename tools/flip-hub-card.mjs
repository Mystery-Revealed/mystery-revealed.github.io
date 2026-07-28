#!/usr/bin/env node
/**
 * flip-hub-card — the ONLY supported way to point a hub card at a live app.
 *
 * Why this exists
 * ---------------
 * Hub cards kept silently reverting to "coming soon". The cause was never caching:
 * a session would read index.html into its context, do other work, then later write
 * the WHOLE file back. GitHub's `sha` guard did not catch it, because the session
 * re-read the file just to get a fresh sha while still sending its stale content —
 * so every flip that landed in between was erased. A history replay on 2026-07-27
 * found 10 such regressions across 5 commits; 4 cards were still broken.
 *
 * This tool removes that failure mode:
 *   - content and sha come from ONE fetch, so a concurrent write causes a 409 and a
 *     retry against fresh content instead of a silent overwrite;
 *   - it changes exactly one line, and refuses to continue if any other line moved or
 *     if any URL that was live before is not live after;
 *   - it refuses to link a URL that is not actually serving;
 *   - it forces the Pages rebuild and confirms the live page really changed.
 *
 * Usage
 *   node flip-hub-card.mjs --slug us-era-sorter --url https://…/us-era-sorter/
 *   node flip-hub-card.mjs --slug … --url … --hub us-history-part-2
 *   node flip-hub-card.mjs --slug … --url … --dry-run
 *   node flip-hub-card.mjs --audit                # replay history, list regressions
 *   node flip-hub-card.mjs --audit --check-urls   # …and curl every live card
 */

import { execFileSync } from 'node:child_process';

const REPO = 'Mystery-Revealed/mystery-revealed.github.io';
const DEFAULT_HUB = 'us-history-part-1';
const MAX_PUT_ATTEMPTS = 5;
const COLD_START_MS = 150_000;      // Render free tier can take 12-25s to wake

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const HUB = opt('hub', DEFAULT_HUB);
const PATH_ = `${HUB}/index.html`;

/** Throws rather than process.exit(): exiting while an undici socket is still open
 *  trips a libuv assertion on Windows and reports 127 instead of our exit code. */
class Abort extends Error {}
const die = (msg) => { throw new Abort(msg); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ------------------------------------------------------------------ gh helper
function gh(args, { input } = {}) {
  try {
    return execFileSync('gh', args, {
      input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = new Error((e.stderr || '') + (e.stdout || ''));
    err.raw = e;
    throw err;
  }
}
const ghJSON = (args) => JSON.parse(gh(args));

function readHub(ref) {
  const q = ref ? `?ref=${ref}` : '';
  const r = ghJSON(['api', `repos/${REPO}/contents/${PATH_}${q}`]);
  return { html: Buffer.from(r.content, 'base64').toString('utf8'), sha: r.sha };
}

// --------------------------------------------------------------- card parsing
const CARD_RE =
  /<a class="card" href="([^"]+)"[\s\S]{0,600}?<div class="title">([^<]+)<\/div>/g;

function cards(html) {
  const m = new Map();
  for (const c of html.matchAll(CARD_RE)) m.set(c[2].trim(), c[1]);
  return m;
}
const isLive = (href) => !href.includes('/coming-soon/');
const liveSet = (html) =>
  new Set([...cards(html).values()].filter(isLive));

/** Card titles and coming-soon slugs are the same string under one transform, so a card
 *  stays identifiable by slug even AFTER it is flipped and the ?item= slug disappears.
 *  "Freight Tycoon: Wagon, Canal, or Rail?" -> us-freight-tycoon-wagon-canal-or-rail */
const slugOfTitle = (title) =>
  'us-' + title
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Resolve a slug to exactly one card, flipped or not. Returns {title, href} or null. */
function findCard(html, slug) {
  for (const [title, href] of cards(html)) {
    if (slugOfTitle(title) === slug) return { title, href };
    const m = href.match(/\/coming-soon\/\?item=([^&"]+)/);
    if (m && m[1] === slug) return { title, href };
  }
  return null;
}

// ------------------------------------------------------------------ liveness
/** Explicit controller + clearTimeout: AbortSignal.timeout leaves a live handle that
 *  crashes the process on Windows if we exit while it is still pending. */
async function checkServing(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), COLD_START_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal });
    await res.body?.cancel();          // release the socket; an open one crashes exit
    return { ok: res.ok, status: res.status, secs: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { ok: false, status: e.name, secs: (Date.now() - t0) / 1000 };
  } finally { clearTimeout(timer); }
}

async function assertServing(url) {
  const r = await checkServing(url);
  if (!r.ok) die(`${url} returned ${r.status}. Refusing to link a dead URL.`);
  ok(`target serving: HTTP ${r.status} in ${r.secs.toFixed(1)}s`);
}

// ------------------------------------------------------------------ the flip
function applyFlip(html, slug, url) {
  const card = findCard(html, slug);
  if (!card) {
    const near = [...cards(html).keys()].map(slugOfTitle)
      .filter((s) => s.includes(slug.replace(/^us-/, '').split('-')[0]));
    die(`no card matches slug "${slug}" in ${PATH_}.` +
        (near.length ? `\n  Closest slugs:\n${near.map((n) => '    ' + n).join('\n')}` : ''));
  }
  // Already flipped? Only a no-op when THIS card points at THIS url.
  if (isLive(card.href)) {
    if (card.href === url) return { already: card.title };
    die(`"${card.title}" is already linked to a different URL:\n    ${card.href}\n` +
        `  Refusing to silently repoint it. Pass that URL, or edit deliberately.`);
  }

  const before = html;
  const next = html.replace(`href="${card.href}"`, `href="${url}"`);

  // exactly one line may move
  const b = before.split('\n'), a = next.split('\n');
  const moved = b.map((_, i) => i).filter((i) => b[i] !== a[i]);
  if (moved.length !== 1) die(`expected exactly 1 changed line, got ${moved.length} — aborting.`);

  // no previously-live card may be lost (this is the regression that kept happening)
  const lost = [...liveSet(before)].filter((u) => !liveSet(next).has(u));
  if (lost.length) die(`this write would un-link ${lost.length} live card(s):\n${lost.join('\n')}`);

  return { next, line: moved[0] + 1, was: card.href, title: card.title };
}

// ------------------------------------------------------ write with real CAS
function commitFlip(slug, url, dryRun) {
  for (let attempt = 1; attempt <= MAX_PUT_ATTEMPTS; attempt++) {
    const { html, sha } = readHub();          // content AND sha from the same read
    const r = applyFlip(html, slug, url);
    if (r.already) { console.log(`\n• "${r.already}" is already linked to ${url} — nothing to do.\n`); return null; }

    ok(`matched card "${r.title}"`);
    ok(`line ${r.line}: ${r.was}  ->  ${url}`);
    const liveCards = (h) => [...cards(h).values()].filter(isLive).length;
    ok(`${liveCards(r.next)} live cards after (was ${liveCards(html)}); no card un-linked`);
    if (dryRun) { console.log('\n• --dry-run: nothing written.\n'); return null; }

    const body = JSON.stringify({
      message: `Link ${slug} to its live URL`,
      content: Buffer.from(r.next, 'utf8').toString('base64'),
      sha,                                     // ← the sha that matches this content
    });
    try {
      const res = JSON.parse(gh(['api', '-X', 'PUT', `repos/${REPO}/contents/${PATH_}`, '--input', '-'], { input: body }));
      ok(`committed ${res.commit.sha.slice(0, 8)}`);
      return res.commit.sha;
    } catch (e) {
      if (/409|but expected|does not match/i.test(e.message)) {
        console.log(`  … someone else wrote first (attempt ${attempt}/${MAX_PUT_ATTEMPTS}); re-reading and re-applying`);
        continue;                              // ← the whole point: retry, never clobber
      }
      die(`PUT failed:\n${e.message}`);
    }
  }
  die(`gave up after ${MAX_PUT_ATTEMPTS} concurrent-write conflicts.`);
}

// --------------------------------------------------------- publish + confirm
async function publishAndConfirm(commitSha, url) {
  try { gh(['api', '-X', 'POST', `repos/${REPO}/pages/builds`]); } catch { /* build may already be queued */ }
  for (let i = 0; i < 20; i++) {
    const b = ghJSON(['api', `repos/${REPO}/pages/builds/latest`]);
    if (b.status === 'built' && b.commit === commitSha) { ok(`Pages built from ${commitSha.slice(0, 8)}`); break; }
    if (i === 19) die(`Pages never built commit ${commitSha.slice(0, 8)} (latest: ${b.status} ${String(b.commit).slice(0, 8)}).`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  // the plain URL a student hits — not a cache-busted one
  const live = await (await fetch(`https://apps.mysteryrevealededresources.com/${HUB}/`)).text();
  if (live.includes(`href="${url}"`)) ok('live page serves the new link');
  else console.log(`  ! live page not updated yet — GitHub Pages sends max-age=600, so allow ~10 min or hard-refresh`);
}

// ------------------------------------------------------------------- audit
async function audit(checkUrls) {
  console.log(`\nReplaying every version of ${PATH_} …`);
  const commits = ghJSON(['api', `repos/${REPO}/commits?path=${PATH_}&per_page=100`, '--paginate'])
    .map((c) => ({ sha: c.sha, date: c.commit.author.date, msg: c.commit.message.split('\n')[0] }))
    .reverse();

  const everLive = new Map(); const regressions = []; let prev = null;
  for (const c of commits) {
    const cur = cards(readHub(c.sha).html);
    if (prev) for (const [title, href] of cur) {
      const p = prev.get(title);
      if (p && isLive(p) && !isLive(href)) regressions.push({ title, lost: p, at: c.sha.slice(0, 8), msg: c.msg, date: c.date.slice(0, 10) });
    }
    for (const [title, href] of cur) if (isLive(href)) everLive.set(title, { url: href, date: c.date.slice(0, 10) });
    prev = cur;
  }

  console.log(`\n${commits.length} versions · ${prev.size} cards · ${[...prev.values()].filter(isLive).length} live · ${[...prev.values()].filter((h) => !isLive(h)).length} coming-soon`);
  console.log(`\nRegressions in history: ${regressions.length}`);
  for (const r of regressions) console.log(`  ${r.date} ${r.at}  ${r.title}\n      lost: ${r.lost}\n      by:   ${r.msg}`);

  const broken = [...everLive].filter(([t]) => prev.get(t) && !isLive(prev.get(t)));
  console.log(`\nStill broken now: ${broken.length}`);
  for (const [t, i] of broken) console.log(`  ${t}\n      should be: ${i.url}  (last live ${i.date})`);

  if (checkUrls) {
    const urls = [...prev.values()].filter(isLive);
    console.log(`\nChecking ${urls.length} live URLs …`);
    const bad = [];
    await Promise.all(urls.map(async (u) => {
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(COLD_START_MS) });
        if (!r.ok) bad.push(`${r.status} ${u}`);
      } catch (e) { bad.push(`${e.name} ${u}`); }
    }));
    console.log(bad.length ? `Dead links:\n  ${bad.join('\n  ')}` : '  all live cards resolve');
    if (bad.length) process.exitCode = 1;
  }
  if (broken.length) process.exitCode = 1;
  console.log('');
}

// -------------------------------------------------------------------- main
try {
  if (flag('audit')) {
    await audit(flag('check-urls'));
  } else {
    const slug = opt('slug'), url = opt('url');
    if (!slug || !url) die('usage: --slug <item-slug> --url <https://…>   (or --audit)');
    if (!/^https:\/\//.test(url)) die('--url must be https://');
    console.log(`\nFlipping "${slug}" on ${HUB}\n`);
    await assertServing(url);
    const sha = commitFlip(slug, url, flag('dry-run'));
    if (sha) await publishAndConfirm(sha, url);
    console.log('');
  }
} catch (e) {
  console.error(e instanceof Abort ? `\n✖ ${e.message}\n` : `\n✖ unexpected: ${e.stack}\n`);
  process.exitCode = 1;
}
