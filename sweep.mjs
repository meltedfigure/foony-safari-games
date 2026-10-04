#!/usr/bin/env node
/**
 * Plays Foony's live games in real Safari, on a Mac or in the iOS Simulator, through Apple's
 * safaridriver. Run by .github/workflows/safari-games.yml on GitHub's Mac runners. Any W3C
 * WebDriver server works, so it can be tried locally with chromedriver (see CAPABILITIES).
 *
 * For each game: open its page on foony.com, start it against bots in a private room, tap around
 * the game area like a player, save screenshots, and record what went wrong (page errors, the
 * crash screen, sideways scroll, a game that never opened a room). Then leave through the back
 * link and confirm the forfeit prompt, as a player would.
 *
 * Why plain WebDriver and not Playwright: Playwright's "webkit" is its own WebKit build on its own
 * engine settings, not Safari, and it cannot drive the iOS Simulator. safaridriver drives the
 * real Safari that ships with macOS and with each iOS Simulator runtime.
 *
 * Ads: real Safari loads real ads, and a test tap on an ad is an invalid click on Foony's ad
 * account. Every tap first checks what is under the point and skips frames, ad slots and links
 * that leave the site. Buttons are only ever pressed by their text.
 *
 * Limit: WebDriver cannot run a script before the page's own scripts, so errors thrown while a page
 * loads (before the error hook goes in) are not seen.
 *
 * Env:
 *   WEBDRIVER_URL   WebDriver server. Default http://localhost:4444.
 *   SIMULATOR_UDID  iOS Simulator to drive (from `xcrun simctl list`). Unset means Mac Safari.
 *   CAPABILITIES    JSON capabilities that replace the Safari ones, e.g. to try the script with
 *                   chromedriver: '{"browserName":"chrome"}'.
 *   GAMES           "all" (default: every game linked from foony.com/games) or slugs, e.g. "chess,ludo".
 *   BASE_URL        Default https://foony.com.
 *   OUT_DIR         Where results.jsonl, summary.md and screenshots go. Default ./safari-results.
 *   TARGET          Name for this browser in the results, e.g. "iPhone 16". Default "safari".
 *
 * Exits 1 when a game crashed the page, showed the crash screen, scrolled sideways or never opened
 * a room. Page errors alone are listed in the summary but do not fail the run.
 */
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const WEBDRIVER_URL = process.env.WEBDRIVER_URL ?? 'http://localhost:4444';
const SIMULATOR_UDID = process.env.SIMULATOR_UDID ?? '';
const BASE_URL = process.env.BASE_URL ?? 'https://foony.com';
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? 'safari-results');
const TARGET = process.env.TARGET ?? 'safari';
const SHOTS_DIR = path.join(OUT_DIR, 'shots', TARGET.replace(/[^A-Za-z0-9.-]+/g, '_'));
const RESULTS_FILE = path.join(OUT_DIR, 'results.jsonl');
/** W3C WebDriver's key for an element reference inside a JSON value. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
/** A room drops a player 15 s after they leave. The next game starts after that, so the old room can't clear the new room's status. */
const ROOM_DROP_WAIT_MS = 17_000;
const MAC_WINDOW = {width: 1440, height: 900};
/** A WebDriver command that takes longer than this is treated as stuck. Starting Safari in the iOS Simulator can take minutes, so that gets its own limit. */
const COMMAND_TIMEOUT_MS = 90_000;
const SESSION_START_TIMEOUT_MS = 300_000;
const SESSION_START_ATTEMPTS = 4;
/** Commands slower than this are logged by name, so a slow or stuck step is easy to find. */
const SLOW_COMMAND_MS = 15_000;
/** W3C WebDriver time limits, in ms: a page load that takes longer returns early, and the page keeps loading. */
const DRIVER_TIMEOUTS = {pageLoad: 60_000, script: 30_000, implicit: 0};
/** Shown instead of Start Game when a game is in Supporter early access. A guest can't start these. */
const SUPPORTER_ONLY_TEXT = 'Only Supporters can create a room';
/** Words worth recording when the page shows them after the taps. */
const STATE_WORDS = /no longer in this room|has left\.|won in [^\n]{0,30}|Your turn|Get ready|Click the error to copy it|isn't supported|not supported|Something went wrong|Server is restarting|Reconnecting|Disconnected|Couldn't start a guest session/g;
/**
 * Server refusals that Chromium shows the same way on the same steps (checked 2026-10-04), so
 * they are not Safari bugs. The summary marks them instead of hiding them.
 */
const KNOWN_SHARED_ERRORS = [
  [/Game hasn't started yet/, 'a tap landed in the countdown, Chromium too'],
  [/Bad gameSession/, 'a move was sent while leaving, Chromium too'],
];

/** Collects errors on the page from now on. A full page load drops it, so it goes in after every load. */
const HOOK_SCRIPT = `
  if (!window.__safariSweepErrors) {
    window.__safariSweepErrors = [];
    const push = (kind, text) => window.__safariSweepErrors.push(kind + ': ' + String(text).slice(0, 600));
    window.addEventListener('error', (event) => push('error', [event.message, event.filename && event.filename + ':' + event.lineno + ':' + event.colno, event.error && event.error.stack].filter(Boolean).join(' | ')), true);
    window.addEventListener('unhandledrejection', (event) => push('rejection', (event.reason && (event.reason.stack || event.reason.message)) || event.reason));
    const originalError = console.error;
    console.error = function (...args) {
      push('console.error', args.map((arg) => (arg && arg.stack) || (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' '));
      return originalError.apply(this, args);
    };
  }
  return true;
`;

/** What the page shows: room words, crash screen, canvases and sideways scroll. */
const SUMMARY_SCRIPT = `
  const text = document.body.innerText;
  return {
    path: location.pathname + location.hash,
    words: [...new Set(text.match(new RegExp(arguments[0], 'g')) || [])],
    crashScreen: text.includes('Click the error to copy it'),
    canvases: [...document.querySelectorAll('canvas')].map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return Math.round(rect.width) + 'x' + Math.round(rect.height);
    }).filter((size) => size !== '0x0'),
    overflowX: document.documentElement.scrollWidth - innerWidth,
  };
`;

mkdirSync(SHOTS_DIR, {recursive: true});
const session = await startSession();
console.log(`[safari-games] ${TARGET}: ${session.browser}`);
const results = [];
try {
  const slugs = (process.env.GAMES ?? 'all') === 'all' ? await readLiveSlugs() : process.env.GAMES.split(',').map((slug) => slug.trim()).filter(Boolean);
  console.log(`[safari-games] ${TARGET}: ${slugs.length} games: ${slugs.join(' ')}`);
  for (const slug of slugs) {
    const result = await playGame(slug).catch((error) => ({slug, failed: String(error.message).split('\n')[0].slice(0, 300)}));
    Object.assign(result, {target: TARGET, browser: session.browser});
    results.push(result);
    appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
    console.log(`[safari-games] ${TARGET} ${slug}: ${describeProblems(result).join('; ') || 'ok'}`);
    if (result.sessionLost) {
      try {
        await session.restart();
      } catch (error) {
        // safaridriver keeps the stuck session paired with Safari, so no new session can start.
        console.log(`[safari-games] ${TARGET}: could not start a new Safari session, skipping the other games: ${error.message}`);
        results.push({slug: 'the remaining games', failed: `not run, Safari stayed stuck: ${error.message.slice(0, 200)}`, target: TARGET, browser: session.browser});
        break;
      }
    }
  }
} finally {
  await session.stop();
}
const summary = buildSummary(results);
writeFileSync(path.join(OUT_DIR, `summary-${path.basename(SHOTS_DIR)}.md`), summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
process.exit(results.some((result) => describeProblems(result).length > 0) ? 1 : 0);

/** Starts one game against bots, taps around, takes screenshots, sums up the page, and leaves. */
async function playGame(slug) {
  const result = {slug};
  const startedAt = performance.now();
  try {
    await session.go(`${BASE_URL}/games/${slug}`);
    await session.run(HOOK_SCRIPT);
    result.opened = await waitForButton(['Play Bots', 'Quick Play'], 30_000);
    if (!result.opened) {
      await session.saveShot(`${slug}-landing`);
      return finish(result, startedAt);
    }
    await pressButton(result.opened);
    await sleep(3_000);
    if ((await session.run('return document.body.innerText')).includes(SUPPORTER_ONLY_TEXT)) {
      result.supporterOnly = true;
      await session.saveShot(slug);
      return finish(result, startedAt);
    }
    if (await findButton('Private')) {
      await pressButton('Private');
      await sleep(500);
    }
    // Some games start from Play Bots alone (no settings dialog), so Start Game is optional.
    if (await findButton('Start Game')) {
      await pressButton('Start Game');
    }
    result.roomSeconds = await waitForRoom(30_000);
    await sleep(8_000);
    await session.saveShot(`${slug}-start`);
    result.taps = await tapAround();
    await sleep(4_000);
    Object.assign(result, await session.run(SUMMARY_SCRIPT, STATE_WORDS.source));
    await session.saveShot(slug);
    result.left = await leaveGame(slug);
    await sleep(ROOM_DROP_WAIT_MS);
  } catch (error) {
    // Safari's page or the whole session died: record it, and the caller starts a new session.
    if (/invalid session id|no such window|session.*(deleted|terminated|not created)|ECONNREFUSED|fetch failed|stuck/i.test(String(error.message))) {
      result.sessionLost = String(error.message).split('\n')[0].slice(0, 300);
      return finish(result, startedAt);
    }
    throw error;
  }
  return finish(result, startedAt);
}

async function finish(result, startedAt) {
  if (!result.sessionLost) {
    result.errors = await session.run('return (window.__safariSweepErrors || []).splice(0)').catch(() => []);
  }
  result.seconds = Math.round((performance.now() - startedAt) / 1000);
  return result;
}

/** Reads the game slugs linked from the live /games page, so new games are tested without a list here. */
async function readLiveSlugs() {
  await session.go(`${BASE_URL}/games`);
  await sleep(6_000);
  for (let i = 0; i < 10; i++) {
    await session.run('scrollBy(0, 3000); return true;');
    await sleep(400);
  }
  return session.run(`return [...new Set([...document.querySelectorAll('a[href^="/games/"]')]
    .map((anchor) => anchor.getAttribute('href').split(/[?#]/)[0].split('/')[2]).filter(Boolean))];`);
}

/** Waits until the page is in a room (#r= in the URL). Returns how many seconds that took, or null. */
async function waitForRoom(timeoutMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if ((await session.run('return location.hash')).includes('r=')) {
      return Math.round((performance.now() - startedAt) / 100) / 10;
    }
    await sleep(250);
  }
  return null;
}

/**
 * Taps a 3x3 grid over the biggest canvas, or over the middle of the screen when the game has no
 * canvas. Skips any point over a frame, an ad slot, a link off the site, or a control that leaves
 * the game, and cancels the forfeit prompt if a tap opened it.
 */
async function tapAround() {
  const points = await session.run(`
    const canvases = [...document.querySelectorAll('canvas')].map((canvas) => canvas.getBoundingClientRect()).filter((rect) => rect.width > 50 && rect.height > 50);
    canvases.sort((left, right) => right.width * right.height - left.width * left.height);
    const rect = canvases[0];
    const top = rect ? Math.max(rect.top, innerHeight * 0.15) : innerHeight * 0.25;
    const bottom = rect ? Math.min(rect.bottom, innerHeight * 0.85) : innerHeight * 0.75;
    const left = rect ? Math.max(rect.left, 0) : innerWidth * 0.15;
    const right = rect ? Math.min(rect.right, innerWidth) : innerWidth * 0.85;
    const points = [];
    for (const yFraction of [0.25, 0.5, 0.75]) {
      for (const xFraction of [0.25, 0.5, 0.75]) {
        points.push({x: Math.round(left + (right - left) * xFraction), y: Math.round(top + (bottom - top) * yFraction)});
      }
    }
    return {kind: rect ? 'canvas' : 'screen', points};
  `);
  let count = 0;
  for (const point of points.points) {
    const isSafe = await session.run(`
      const element = document.elementFromPoint(arguments[0], arguments[1]);
      if (!element || element.closest('iframe, ins, [id*="google_ads"], [class*="adsbygoogle"], [data-ad-slot], [id*="Venatus"], [id*="Platform"]')) {
        return false;
      }
      const link = element.closest('a[href]');
      if (link && new URL(link.href, location.href).origin !== location.origin) {
        return false;
      }
      const control = element.closest('a, button, [role=button], input, textarea');
      return !control || !/leave|back|resign|quit|exit|forfeit|home|chat|menu|report|share|invite|log in|sign up/i.test(
        (control.innerText || '') + ' ' + (control.getAttribute('aria-label') || '') + ' ' + (control.getAttribute('title') || '') + ' ' + (control.getAttribute('href') || ''));
    `, point.x, point.y);
    if (!isSafe) {
      continue;
    }
    await session.tap(point.x, point.y);
    count++;
    await sleep(700);
    if ((await session.run('return document.body.innerText')).includes('want to forfeit')) {
      await pressButton('Cancel');
    }
  }
  return `${count} on ${points.kind}`;
}

/** Leaves through the in-app back link (as a player would) and confirms the forfeit prompt. */
async function leaveGame(slug) {
  const didClick = await session.run(`
    const link = [...document.querySelectorAll('a')].find((anchor) => anchor.getAttribute('href') === arguments[0] && anchor.getBoundingClientRect().width > 0);
    if (link) {
      link.click();
    }
    return Boolean(link);
  `, `/games/${slug}`);
  await sleep(1_500);
  const didConfirm = (await findButton('Yes, Please')) ? await pressButton('Yes, Please') : false;
  await sleep(1_500);
  return {backLink: didClick, confirmed: didConfirm};
}

/**
 * Waits up to `timeoutMs` for one of the button texts to show with React attached, and returns the
 * first that does, or null. A tap on the server-sent button before React attaches does nothing.
 */
async function waitForButton(texts, timeoutMs) {
  const endAt = performance.now() + timeoutMs;
  while (performance.now() < endAt) {
    for (const text of texts) {
      if (await findButton(text)) {
        return text;
      }
    }
    await sleep(500);
  }
  return null;
}

/** The smallest visible button or link whose text has `text` and that React drives, scrolled into view, or null. */
function findButton(text) {
  return session.run(`
    const wanted = arguments[0].toLowerCase();
    const matches = [...document.querySelectorAll('button, a, [role=button]')].filter((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (candidate.innerText || candidate.getAttribute('aria-label') || '').toLowerCase().includes(wanted);
    });
    matches.sort((left, right) => left.innerText.length - right.innerText.length);
    if (!matches[0] || !Object.keys(matches[0]).some((key) => key.startsWith('__reactProps'))) {
      return null;
    }
    matches[0].scrollIntoView({block: 'center'});
    return matches[0];
  `, text);
}

/** Presses the button with `text` through WebDriver, like a finger or mouse. Returns false when there is none. */
async function pressButton(text) {
  const element = await findButton(text);
  if (!element) {
    return false;
  }
  await session.click(element);
  return true;
}

/** Lists what looks broken in one game's result. Empty means the game worked. */
function describeProblems(result) {
  const problems = [];
  if (result.failed) {
    problems.push(`script failed: ${result.failed}`);
  }
  if (result.sessionLost) {
    problems.push(`Safari crashed or closed: ${result.sessionLost}`);
  }
  if (result.crashScreen) {
    problems.push('crash screen');
  }
  if (result.overflowX > 0) {
    problems.push(`page scrolls sideways by ${result.overflowX}px`);
  }
  if (!result.failed && !result.sessionLost && !result.supporterOnly) {
    if (!result.opened) {
      problems.push('no Play Bots or Quick Play button');
    } else if (result.roomSeconds == null) {
      problems.push('never opened a room');
    }
  }
  return problems;
}

/** Builds the markdown summary: one row per game, then every page error with known ones marked. */
function buildSummary(gameResults) {
  const lines = [`## ${TARGET} (${session.browser})`, '', '| Game | Result | Room | Taps | Errors |', '| --- | --- | --- | --- | --- |'];
  for (const result of gameResults) {
    const problems = describeProblems(result);
    const outcome = problems.length > 0 ? `❌ ${problems.join('; ')}` : result.supporterOnly ? 'Supporter only (guest can\'t start)' : '✅ ok';
    lines.push(`| ${result.slug} | ${outcome} | ${result.roomSeconds == null ? '-' : result.roomSeconds + ' s'} | ${result.taps ?? '-'} | ${(result.errors ?? []).length} |`);
  }
  const errorLines = gameResults.flatMap((result) => (result.errors ?? []).map((error) => {
    const known = KNOWN_SHARED_ERRORS.find(([pattern]) => pattern.test(error));
    return `- ${result.slug}: \`${error.split('\n')[0].slice(0, 200).replaceAll('`', "'")}\`${known ? ` (known: ${known[1]})` : ''}`;
  }));
  if (errorLines.length > 0) {
    lines.push('', '### Page errors', ...errorLines);
  }
  return lines.join('\n') + '\n\n';
}

/** Starts a WebDriver session for Mac Safari, iOS Simulator Safari, or CAPABILITIES, and returns the calls this script uses. */
async function startSession() {
  const isSimulator = SIMULATOR_UDID !== '' && !process.env.CAPABILITIES;
  const capabilities = process.env.CAPABILITIES
    ? JSON.parse(process.env.CAPABILITIES)
    : isSimulator
      ? {browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': SIMULATOR_UDID}
      : {browserName: 'safari', platformName: 'mac'};
  let sessionId = '';
  let browser = '';
  // Touch for the iOS Simulator, a mouse elsewhere. Falls back to a WebDriver element click if
  // the driver refuses pointer actions.
  let canUsePointerActions = true;
  const callSession = (method, route, body) => callDriver(method, `/session/${sessionId}${route}`, body);
  async function open() {
    const value = await openWithRetries();
    sessionId = value.sessionId;
    browser = `${value.capabilities?.browserName ?? '?'} ${value.capabilities?.browserVersion ?? '?'}`;
    await callSession('POST', '/timeouts', DRIVER_TIMEOUTS).catch((error) => console.warn(`[safari-games] could not set the driver time limits: ${error.message}`));
    if (!isSimulator) {
      await callSession('POST', '/window/rect', MAC_WINDOW).catch((error) => console.warn(`[safari-games] could not set the window size: ${error.message}`));
    }
  }
  /**
   * Asks for a session, trying again when Safari is not ready yet. A just-booted iOS Simulator can
   * take longer than safaridriver's own 30 s limit to bring Safari up.
   */
  async function openWithRetries() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callDriver('POST', '/session', {capabilities: {alwaysMatch: capabilities}});
      } catch (error) {
        if (attempt >= SESSION_START_ATTEMPTS || !/session not created/i.test(error.message)) {
          throw error;
        }
        console.log(`[safari-games] ${TARGET}: Safari session attempt ${attempt} failed, trying again in 15 s: ${error.message.slice(0, 200)}`);
        await sleep(15_000);
      }
    }
  }
  await open();
  const api = {
    get browser() {
      return browser;
    },
    async go(url) {
      try {
        await callSession('POST', '/url', {url});
      } catch (error) {
        if (!/timeout/i.test(error.message) || /stuck/.test(error.message)) {
          throw error;
        }
        // The page took longer than the page-load limit. It keeps loading, so carry on with it.
        console.log(`[safari-games] ${url} took over ${DRIVER_TIMEOUTS.pageLoad / 1000} s to load, carrying on`);
      }
    },
    run: (script, ...args) => callSession('POST', '/execute/sync', {script, args}),
    async saveShot(name) {
      const base64 = await callSession('GET', '/screenshot');
      writeFileSync(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(base64, 'base64'));
    },
    async click(element) {
      try {
        await callSession('POST', `/element/${element[ELEMENT_KEY]}/click`, {});
      } catch (error) {
        if (!/intercepted|not interactable/i.test(error.message)) {
          throw error;
        }
        // Something sits over the button (a toast or a dialog edge): press it from JS instead.
        await api.run('arguments[0].click(); return true;', element);
      }
    },
    async tap(x, y) {
      if (canUsePointerActions) {
        try {
          await callSession('POST', '/actions', {actions: [{
            type: 'pointer',
            id: 'finger',
            parameters: {pointerType: isSimulator ? 'touch' : 'mouse'},
            actions: [
              {type: 'pointerMove', duration: 0, origin: 'viewport', x, y},
              {type: 'pointerDown', button: 0},
              {type: 'pause', duration: 60},
              {type: 'pointerUp', button: 0},
            ],
          }]});
          return;
        } catch (error) {
          if (/invalid session id|no such window/i.test(error.message)) {
            throw error;
          }
          canUsePointerActions = false;
          console.warn(`[safari-games] pointer actions refused, tapping with element clicks from now on: ${error.message.slice(0, 200)}`);
        }
      }
      const element = await api.run('return document.elementFromPoint(arguments[0], arguments[1]);', x, y);
      if (element) {
        await api.click(element);
      }
    },
    async restart() {
      await api.stop();
      await open();
      console.log(`[safari-games] ${TARGET}: started a new session after the last one was lost`);
    },
    async stop() {
      await callSession('DELETE', '', undefined).catch((error) => console.warn(`[safari-games] could not close the session: ${error.message}`));
    },
  };
  return api;
}

/** Sends one WebDriver command and returns its value. Rejects with the driver's error and message. */
async function callDriver(method, route, body) {
  const timeoutMs = route === '/session' ? SESSION_START_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(WEBDRIVER_URL + route, {
      method,
      headers: {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? `${method} ${commandName(route)} got no answer within ${timeoutMs / 1000} s (stuck)` : `${method} ${commandName(route)} failed: ${error.message}`);
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > SLOW_COMMAND_MS) {
    console.log(`[safari-games] slow WebDriver command: ${method} ${commandName(route)} took ${Math.round(elapsedMs / 1000)} s`);
  }
  const text = await response.text();
  const value = text ? JSON.parse(text).value : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} answered HTTP ${response.status}: ${value?.error ?? ''} ${value?.message ?? text.slice(0, 300)}`);
  }
  return value;
}

/** The command part of a WebDriver route, without the session and element ids (e.g. "/element/click"). */
function commandName(route) {
  return route.replace(/^\/session\/[^/]+/, '').replace(/\/element\/[^/]+/, '/element') || '/session';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
