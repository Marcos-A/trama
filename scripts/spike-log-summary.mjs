#!/usr/bin/env node
// Summarise spike diagnostics logs (the JSON from "Baixa el registre") for docs/manual-tests.md.
//
//   node scripts/spike-log-summary.mjs <log.json> [more.json ...]
//
// Prints, per recording in each log: browser, stop reason, duration, size, chunk gaps, heap
// trend, audio problems, recovery/export, then a draft row for the Results table. The draft
// leaves macOS, the check number and A/V sync to fill in by hand: the log cannot know them.
// Logs are treated as data only (JSON.parse), never executed.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const ERROR_EVENTS = new Set([
  'picker-failed', 'start-failed', 'write-error', 'recorder-error', 'worker-error',
  'export-failed', 'player-error', 'unsupported', 'non-tab-surface',
]);

function browserOf(env = {}) {
  const ua = String(env.userAgent ?? '');
  const brands = env.userAgentData?.brands ?? [];
  const pick = (re) => brands.find((b) => re.test(b.brand));
  const edge = pick(/Edge/) ?? (/Edg\/(\S+)/.exec(ua) && { brand: 'Edge', version: /Edg\/(\S+)/.exec(ua)[1] });
  if (edge) return `Edge ${edge.version}`;
  const chrome = pick(/^Google Chrome$/) ?? (/Chrome\/(\S+)/.exec(ua) && { brand: 'Chrome', version: /Chrome\/(\S+)/.exec(ua)[1] });
  if (chrome) return `Chrome ${chrome.version}`;
  return ua || 'unknown';
}

const t = (iso) => Date.parse(iso);
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const round1 = (n) => Math.round(n * 10) / 10;

/** Split entries into recordings: recording-started … recording-stopped (or end of log). */
function splitRuns(entries) {
  const runs = [];
  let cur = null;
  for (const e of entries) {
    if (e.ev === 'recording-started') {
      cur = { start: e, events: [] };
      runs.push(cur);
    }
    if (cur) cur.events.push(e);
    if (e.ev === 'recording-stopped') cur = null;
  }
  return runs;
}

function summariseRun(run) {
  const ev = (name) => run.events.filter((e) => e.ev === name);
  const startData = run.start.data ?? {};
  const stopped = ev('recording-stopped')[0];
  const samples = ev('sample').map((e) => e.data ?? {});
  const gaps = ev('chunk-gap').map((e) => e.data ?? {});
  const tracks = startData.tracks ?? [];
  const video = tracks.find((tr) => tr.kind === 'video');
  const hasAudio = tracks.some((tr) => tr.kind === 'audio');

  // Time spent hidden, from visibility events inside the run.
  let hiddenMs = 0;
  let hiddenSince = null;
  for (const e of run.events) {
    if (e.ev !== 'visibility') continue;
    if (e.data === 'hidden' && hiddenSince === null) hiddenSince = t(e.at);
    if (e.data === 'visible' && hiddenSince !== null) { hiddenMs += t(e.at) - hiddenSince; hiddenSince = null; }
  }
  const endAt = stopped ? t(stopped.at) : t(run.events.at(-1).at);
  if (hiddenSince !== null) hiddenMs += endAt - hiddenSince;

  const heaps = samples.map((s) => s.heapMB).filter((h) => typeof h === 'number');
  const durationS = stopped?.data?.durationS ?? Math.round((endAt - t(run.start.at)) / 1000);
  const fileMB = stopped?.data?.fileMB ?? samples.at(-1)?.fileMB;
  const chunks = stopped?.data?.chunks;

  return {
    name: startData.name,
    startedAt: run.start.at,
    mimeType: startData.mimeType,
    surface: video?.settings?.displaySurface,
    resolution: video?.settings?.width ? `${video.settings.width}×${video.settings.height}@${round1(video.settings.frameRate ?? 0)}` : undefined,
    hasAudio,
    stopReason: stopped?.data?.reason ?? '(no stop: tab closed or log taken mid-recording)',
    durationS,
    fileMB: fileMB ?? '?',
    mbPerMin: fileMB && durationS ? round1(fileMB / (durationS / 60)) : undefined,
    chunks,
    chunkRatio: chunks && durationS ? round1(chunks / durationS) : undefined, // ≈1 with a 1 s timeslice
    gaps: gaps.length,
    gapMaxMs: gaps.length ? Math.max(...gaps.map((g) => g.ms ?? 0)) : 0,
    gapsHidden: gaps.filter((g) => g.hidden).length,
    heapFirst: startData.heapMB ?? heaps[0],
    heapLast: stopped?.data?.heapMB ?? heaps.at(-1),
    heapMax: heaps.length ? Math.max(...heaps) : undefined,
    maxWriteMs: samples.length ? Math.max(...samples.map((s) => s.maxWriteMs ?? 0)) : undefined,
    minFreeMB: samples.length ? Math.min(...samples.map((s) => s.storage?.free ?? Infinity)) : startData.storage?.free,
    hiddenS: Math.round(hiddenMs / 1000),
    trackEvents: run.events.filter((e) => /^track-/.test(e.ev)).map((e) => `${e.ev}:${e.data?.kind}`),
    silences: ev('audio-silence-end').map((e) => e.data?.seconds),
    silenceOpen: ev('audio-silence-start').length > ev('audio-silence-end').length,
    errors: run.events.filter((e) => ERROR_EVENTS.has(e.ev)).map((e) => `${e.ev} ${JSON.stringify(e.data ?? '')}`),
  };
}

function summariseLog(path) {
  const { env, entries = [] } = JSON.parse(readFileSync(path, 'utf8'));
  const browser = browserOf(env);
  const loads = entries.filter((e) => e.ev === 'page-loaded');
  const runs = splitRuns(entries).map(summariseRun);
  const after = (ev) => entries.filter((e) => e.ev === ev);
  const outsideErrors = entries
    .filter((e) => ERROR_EVENTS.has(e.ev))
    .filter((e) => !splitRuns(entries).some((r) => r.events.includes(e)))
    .map((e) => `${e.at} ${e.ev} ${JSON.stringify(e.data ?? '')}`);

  console.log(`\n## ${basename(path)}`);
  console.log(`Browser: ${browser}   (UA platform: ${env?.userAgentData?.platform ?? '?'}; macOS version not in log)`);
  console.log(`Page loads: ${loads.length}${loads.some((l) => l.data?.simulatedQuotaMB) ? ` (quota simulation: ${loads.map((l) => l.data?.simulatedQuotaMB).filter(Boolean).join(', ')} MB)` : ''}`);
  for (const l of after('leftovers')) if (Array.isArray(l.data) && l.data.length) console.log(`Leftovers at load: ${l.data.map((f) => `${f.name} (${round1(f.size / 1e6)} MB)`).join(', ')}`);
  for (const r of after('recover')) console.log(`Recovered: ${r.data?.name} (${round1((r.data?.size ?? 0) / 1e6)} MB)`);
  for (const p of after('player-metadata')) console.log(`Player: ${p.data?.width}×${p.data?.height}, duration ${p.data?.duration ?? 'Infinity (WebM not repaired)'}`);
  for (const x of after('export')) console.log(`Export: ${x.data?.result} ${x.data?.name} ${round1((x.data?.size ?? 0) / 1e6)} MB in ${x.data?.ms} ms`);
  if (outsideErrors.length) console.log(`Errors outside recordings:\n  ${outsideErrors.join('\n  ')}`);

  runs.forEach((r, i) => {
    console.log(`\n### Recording ${i + 1}: ${r.name ?? '?'} (started ${r.startedAt})`);
    console.log(`  mime ${r.mimeType}; surface ${r.surface}; ${r.resolution ?? '?'}; audio track: ${r.hasAudio ? 'yes' : 'NO'}`);
    console.log(`  stop: ${r.stopReason}; ${fmtDur(r.durationS)}; ${r.fileMB} MB (${r.mbPerMin ?? '?'} MB/min); chunks/s ${r.chunkRatio ?? '?'}`);
    console.log(`  chunk gaps: ${r.gaps}${r.gaps ? ` (max ${r.gapMaxMs} ms, ${r.gapsHidden} while hidden)` : ''}; hidden ${fmtDur(r.hiddenS)}`);
    console.log(`  heap MB: first ${r.heapFirst ?? '?'}, max ${r.heapMax ?? '?'}, last ${r.heapLast ?? '?'}; max write ${r.maxWriteMs ?? '?'} ms; min free ${r.minFreeMB ?? '?'} MB`);
    if (r.trackEvents.length) console.log(`  track events: ${r.trackEvents.join(', ')}`);
    if (r.silences.length || r.silenceOpen) console.log(`  audio silences (s): ${r.silences.join(', ')}${r.silenceOpen ? ' + one still silent at stop' : ''}`);
    if (r.errors.length) console.log(`  errors:\n    ${r.errors.join('\n    ')}`);

    const notes = [
      `${r.fileMB} MB, ${fmtDur(r.durationS)}`,
      `heap ${r.heapFirst ?? '?'}→${r.heapLast ?? '?'} MB (max ${r.heapMax ?? '?'})`,
      `${r.gaps} gaps${r.gaps ? ` (max ${r.gapMaxMs} ms)` : ''}`,
      r.hiddenS ? `hidden ${fmtDur(r.hiddenS)}` : null,
      r.hasAudio ? null : 'no audio track',
      r.silences.length ? `${r.silences.length} silence(s)` : null,
      `stop: ${r.stopReason}`,
      'sync: ?',
    ].filter(Boolean).join('; ');
    console.log(`  row: | ${r.startedAt.slice(0, 10)} | ${browser} | ? | ? | ? | ${notes} |`);
  });
  if (!runs.length) console.log('\n(no recordings in this log)');
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node scripts/spike-log-summary.mjs <log.json> [more.json ...]');
  process.exit(2);
}
for (const p of paths) {
  try {
    summariseLog(p);
  } catch (e) {
    console.error(`\n## ${basename(p)}: could not read (${e.message})`);
    process.exitCode = 1;
  }
}
