// Scores a transcript against a reference: WER overall and per language, and how often the
// language tag on each recognised word matches the reference.
//
// Both sides become one word sequence with a language per word; a single Levenshtein alignment
// over the whole excerpt (no timestamps needed in the reference) attributes each error to the
// language of the reference word (insertions: to the reference word just before). For 5–10 min
// excerpts (≈ 1–2 k words) the alignment table is a few MB.
//
// Reference format (plain text, SRT or VTT): `[ca]` / `[es]` anywhere switch the language of
// the words that follow, so switches inside a turn are marked inline. SRT/VTT numbering and
// timing lines are ignored; other bracketed notes (`[riures]`) are dropped. JSON is also
// accepted: an array of { lang, text } (extra fields such as start/end are ignored).

export type RefLang = 'ca' | 'es' | 'und';

export interface Word {
  w: string;
  lang: RefLang;
}

/** Lower case, unified apostrophes, punctuation removed; keeps l·l and intra-word apostrophes. */
export function normalise(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/l\.l/g, 'l·l')
    .replace(/[‐-―-]/g, ' ')
    .replace(/[^\p{L}\p{N}'·\s]/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function parseReference(src: string): Word[] {
  const trimmed = src.trim();
  if (trimmed.startsWith('[{') || trimmed.startsWith('[\n') || (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.includes('"text"'))) {
    const items = JSON.parse(trimmed) as { lang?: string; text: string }[];
    return items.flatMap((it) => normalise(it.text).map((w) => ({ w, lang: toLang(it.lang) })));
  }
  const out: Word[] = [];
  let lang: RefLang = 'und';
  for (const line of src.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l === 'WEBVTT' || /^\d+$/.test(l) || l.includes('-->') || /^(NOTE|STYLE|REGION)\b/.test(l)) continue;
    for (const part of l.split(/(\[[^\]]*\])/)) {
      const tag = /^\[\s*(ca|es|cat|spa|esp)\s*\]$/i.exec(part);
      if (tag) lang = toLang(tag[1]);
      else if (!part.startsWith('[')) for (const w of normalise(part.replace(/<[^>]+>/g, ' '))) out.push({ w, lang });
    }
  }
  return out;
}

function toLang(s: string | undefined): RefLang {
  const v = (s ?? '').toLowerCase();
  if (v === 'ca' || v === 'cat') return 'ca';
  if (v === 'es' || v === 'spa' || v === 'esp') return 'es';
  return 'und';
}

export function hypothesisWords(segments: { lang: string; text: string }[]): Word[] {
  return segments.flatMap((s) => normalise(s.text).map((w) => ({ w, lang: toLang(s.lang) })));
}

export interface LangStats {
  words: number;
  sub: number;
  del: number;
  ins: number;
  wer: number;
}

export interface Score {
  overall: LangStats;
  byLang: Record<'ca' | 'es' | 'und', LangStats>;
  /** Aligned word pairs (match or substitution) whose hypothesis tag equals the reference tag. */
  tagAccuracy: number;
  tagPairs: number;
  /** confusion[ref][hyp] over aligned pairs. */
  confusion: Record<RefLang, Record<RefLang, number>>;
}

const OP_MATCH = 0;
const OP_SUB = 1;
const OP_DEL = 2;
const OP_INS = 3;

export function score(ref: Word[], hyp: Word[]): Score {
  const n = ref.length;
  const m = hyp.length;
  const W = m + 1;
  const ops = new Uint8Array((n + 1) * W);
  let prev = new Uint32Array(W);
  let cur = new Uint32Array(W);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    ops[j] = OP_INS;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    ops[i * W] = OP_DEL;
    const rw = ref[i - 1].w;
    for (let j = 1; j <= m; j++) {
      const same = rw === hyp[j - 1].w;
      let best = prev[j - 1] + (same ? 0 : 1);
      let op = same ? OP_MATCH : OP_SUB;
      if (prev[j] + 1 < best) {
        best = prev[j] + 1;
        op = OP_DEL;
      }
      if (cur[j - 1] + 1 < best) {
        best = cur[j - 1] + 1;
        op = OP_INS;
      }
      cur[j] = best;
      ops[i * W + j] = op;
    }
    [prev, cur] = [cur, prev];
  }

  const blank = (): LangStats => ({ words: 0, sub: 0, del: 0, ins: 0, wer: 0 });
  const byLang = { ca: blank(), es: blank(), und: blank() };
  const langs: RefLang[] = ['ca', 'es', 'und'];
  const confusion = Object.fromEntries(langs.map((r) => [r, Object.fromEntries(langs.map((h) => [h, 0]))])) as Score['confusion'];
  let tagOk = 0;
  let tagPairs = 0;
  for (const r of ref) byLang[r.lang].words++;

  // Backtrace; insertions are charged to the reference word before them (or the first one).
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = i === 0 ? OP_INS : j === 0 ? OP_DEL : ops[i * W + j];
    if (op === OP_INS) {
      const owner = ref[Math.max(0, i - 1)]?.lang ?? 'und';
      byLang[owner].ins++;
      j--;
    } else if (op === OP_DEL) {
      byLang[ref[i - 1].lang].del++;
      i--;
    } else {
      const r = ref[i - 1];
      const h = hyp[j - 1];
      if (op === OP_SUB) byLang[r.lang].sub++;
      confusion[r.lang][h.lang]++;
      tagPairs++;
      if (r.lang === h.lang) tagOk++;
      i--;
      j--;
    }
  }

  const overall = blank();
  for (const l of langs) {
    const s = byLang[l];
    s.wer = s.words ? (s.sub + s.del + s.ins) / s.words : 0;
    overall.words += s.words;
    overall.sub += s.sub;
    overall.del += s.del;
    overall.ins += s.ins;
  }
  overall.wer = overall.words ? (overall.sub + overall.del + overall.ins) / overall.words : 0;
  return { overall, byLang, tagAccuracy: tagPairs ? tagOk / tagPairs : 0, tagPairs, confusion };
}
