#!/usr/bin/env node
/**
 * Checks which pictures a real Safari can decode, on a Mac or in the iOS Simulator, through Apple's
 * safaridriver. Run by .github/workflows/safari-games.yml when its "probe" input is "images".
 *
 * Why: on iOS 15.5, Safari failed to load some of Foony's lossless WebP pictures (Battleblobs'
 * grid and Dino-Might's empty boom tiles, saved with a palette of 1 to 3 colours) while iOS 16 loaded
 * them. This loads every picture in probe-images/urls.txt from foony.com, plus the made-up pictures
 * in probe-images/palette/ (random pixels with 1 to 200 colours, saved lossless and lossy), and
 * lists every one that fails, so the failing kind of file is plain to see.
 *
 * It opens foony.com/robots.txt first, so no game code or ads run while the pictures load.
 *
 * Env: WEBDRIVER_URL (default http://localhost:4444), SIMULATOR_UDID (unset means Mac Safari),
 * TARGET (name in the results), OUT_DIR (default ./safari-results).
 *
 * Exits 1 when any picture fails to load.
 */
import {appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const WEBDRIVER_URL = process.env.WEBDRIVER_URL ?? 'http://localhost:4444';
const SIMULATOR_UDID = process.env.SIMULATOR_UDID ?? '';
const TARGET = process.env.TARGET ?? 'safari';
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? 'safari-results');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BASE_URL = 'https://foony.com';
/** Pictures per script call. Each call waits for all of its pictures, up to LOAD_TIMEOUT_MS each. */
const BATCH_SIZE = 40;
const LOAD_TIMEOUT_MS = 20_000;
/** A just-booted iOS Simulator can take minutes to bring Safari up, so a new session is tried again. */
const SESSION_START_ATTEMPTS = 20;

/** Loads each picture in arguments[0] with a new Image, and answers {src, ok, width, height} for each. */
const LOAD_SCRIPT = `
  const [sources, timeoutMs, done] = arguments;
  Promise.all(sources.map((source) => new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve({ok: false, reason: 'timeout'}), timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve({ok: image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight, reason: image.naturalWidth > 0 ? '' : 'loaded with no size'});
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve({ok: false, reason: 'error'});
    };
    image.src = source;
  }))).then(done);
`;

mkdirSync(OUT_DIR, {recursive: true});
const pictures = [
  ...readFileSync(path.join(HERE, 'probe-images/urls.txt'), 'utf8').split('\n').filter(Boolean).map((urlPath) => ({name: urlPath, source: BASE_URL + urlPath})),
  ...readdirSync(path.join(HERE, 'probe-images/palette')).sort().map((file) => ({
    name: `palette/${file}`,
    source: `data:${file.endsWith('.png') ? 'image/png' : 'image/webp'};base64,${readFileSync(path.join(HERE, 'probe-images/palette', file)).toString('base64')}`,
  })),
];
const {sessionId, browser} = await startSession();
const results = [];
try {
  await callDriver('POST', `/session/${sessionId}/timeouts`, {script: BATCH_SIZE * LOAD_TIMEOUT_MS, pageLoad: 60_000});
  await callDriver('POST', `/session/${sessionId}/url`, {url: `${BASE_URL}/robots.txt`});
  for (let start = 0; start < pictures.length; start += BATCH_SIZE) {
    const batch = pictures.slice(start, start + BATCH_SIZE);
    const answers = await callDriver('POST', `/session/${sessionId}/execute/async`, {script: LOAD_SCRIPT, args: [batch.map((picture) => picture.source), LOAD_TIMEOUT_MS]});
    batch.forEach((picture, index) => results.push({name: picture.name, ...answers[index]}));
    console.log(`[image-probe] ${TARGET}: ${results.length}/${pictures.length} loaded, ${results.filter((result) => !result.ok).length} failed so far`);
  }
} finally {
  await callDriver('DELETE', `/session/${sessionId}`).catch((error) => console.warn(`[image-probe] could not close the session: ${error.message}`));
}

const failed = results.filter((result) => !result.ok);
const lines = [`## Pictures in ${TARGET} (${browser})`, '', `${results.length - failed.length} of ${results.length} loaded.`, ''];
if (failed.length > 0) {
  lines.push('### Failed', ...failed.map((result) => `- \`${result.name}\` (${result.reason})`), '');
}
const palette = results.filter((result) => result.name.startsWith('palette/'));
lines.push('### Made-up palette pictures', '| Picture | Loaded |', '| --- | --- |', ...palette.map((result) => `| ${result.name.slice('palette/'.length)} | ${result.ok ? 'yes' : `NO (${result.reason})`} |`), '');
const summary = lines.join('\n') + '\n';
writeFileSync(path.join(OUT_DIR, `images-${TARGET.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`), JSON.stringify(results, null, 1));
writeFileSync(path.join(OUT_DIR, `images-${TARGET.replace(/[^A-Za-z0-9.-]+/g, '_')}.md`), summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
console.log(summary);
process.exit(failed.length > 0 ? 1 : 0);

/**
 * Starts a Safari session (Mac, or the iOS Simulator SIMULATOR_UDID), trying again while Safari is
 * not up yet. Returns the session id and the browser's name and version (e.g. "Safari 15.5").
 */
async function startSession() {
  const capabilities = SIMULATOR_UDID
    ? {browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': SIMULATOR_UDID}
    : {browserName: 'safari', platformName: 'mac'};
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await callDriver('POST', '/session', {capabilities: {alwaysMatch: capabilities}});
      const browser = `${value.capabilities?.browserName ?? '?'} ${value.capabilities?.browserVersion ?? '?'}`;
      console.log(`[image-probe] ${TARGET}: ${browser}`);
      return {sessionId: value.sessionId, browser};
    } catch (error) {
      if (attempt >= SESSION_START_ATTEMPTS || !/session not created/i.test(error.message)) {
        throw error;
      }
      console.log(`[image-probe] ${TARGET}: Safari session attempt ${attempt} failed, trying again in 15 s: ${error.message.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}

/** Sends one WebDriver command and returns its value. Rejects with the driver's error and message. */
async function callDriver(method, route, body) {
  const response = await fetch(WEBDRIVER_URL + route, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(route === '/session' ? 300_000 : 1_000_000),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text).value : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} answered HTTP ${response.status}: ${value?.error ?? ''} ${value?.message ?? text.slice(0, 300)}`);
  }
  return value;
}
