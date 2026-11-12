// Catalan vs. Spanish language identification from text, per clause.
//
// Whisper decodes a whole window with one language token, and the code-switching fine-tunes
// are decoded with <|ca|> while writing Spanish passages in Spanish, so the language of each
// passage has to come from somewhere else. The text itself is a strong signal for this pair:
// frequent function words and spelling differ (amb/con, els/los, però/pero, perquè/porque,
// l'/d' contractions, l·l, ç, -ció vs. ñ, ¿, -ción). Scored per clause, so a switch inside one
// Whisper segment is still marked.

export type Lang = 'ca' | 'es';

// Weights are log-odds-ish: positive = Catalan, negative = Spanish. Words shared by both
// languages (de, que, la, el, en, no, un, una…) are absent on purpose.
const WORDS: Record<string, number> = {};
const add = (w: number, list: string) => list.split(/\s+/).forEach((x) => (WORDS[x] = w));

add(3, 'amb els però perquè doncs també això aquest aquesta aquests aquestes allò avui és són sóc estic tinc tenim teniu');
add(3, 'seva seves meva meves nostra vostra què gràcies bé ho hi ens us jo nosaltres vosaltres elles mateix mateixa');
add(3, 'encara quan fins després mai només tots totes gaire llavors aleshores potser coses vegada vegades');
add(3, 'vull vols volem podem hem heu hauria hauríem haver fer feina dir diu dic sembla crec creus anem anar mica');
add(3, 'pel pels dels als molt molta molts moltes ningú res altre altra altres bon bona ara');
add(2, 'seu seus meu meus nostre vostre li em et ell tot tota per com');
add(-3, 'con los pero porque entonces también esto eso este esta estos estas aquello hoy está están estamos estoy tengo tenemos tienen');
add(-3, 'sus mis nuestra vuestra qué gracias bien nada nos os yo nosotros vosotros ellos ellas mismo misma');
add(-3, 'todavía cuando hasta después nunca solo sólo todos todas mucho mucha muchos muchas luego quizás quizá vez veces');
add(-3, 'quiero quieres queremos podemos hemos habría haber hacer trabajo decir dice digo parece creo crees vamos ir poco');
add(-3, 'y hay había pues bueno vale nadie ninguno algo otro otra otros otras ahora así sea');
add(-2, 'su mi le lo él todo toda como para uno');

/** Evidence for Catalan (> 0) or Spanish (< 0) in one word. */
export function wordScore(raw: string): number {
  const w = raw.toLowerCase().replace(/[’‘]/g, "'");
  let s = WORDS[w.replace(/^[^\p{L}·']+|[^\p{L}·']+$/gu, '')] ?? 0;
  if (/^(l|d|s|n|m|t)'\p{L}/u.test(w) || /\p{L}'(n|l|s|m|t|ls|ns|hi|ho)$/u.test(w)) s += 3; // l'home, d'acord, fes-ho
  if (/l·l|ç/.test(w)) s += 3;
  if (/[àèò]/.test(w)) s += 2;
  if (/ció$|cions$|ny|tx|ix\b|aix|eix|uix/.test(w)) s += 1.5;
  if (/ñ|[¿¡]/.test(w)) s -= 3;
  if (/ción$|ciones$|mente$/.test(w)) s -= 2;
  if (/á/.test(w)) s -= 2; // Catalan writes à, never á
  if (/ue|ie/.test(w) && !/(que|qüe|gue)/.test(w)) s -= 0.5; // pueden, tiene, siempre
  return s;
}

export interface LangScore {
  lang: Lang | null;
  /** Summed evidence; |score| < 1 counts as no evidence. */
  score: number;
}

export function scoreText(text: string): LangScore {
  let s = 0;
  for (const w of text.split(/[\s\-–—]+/)) if (w) s += wordScore(w);
  return { lang: Math.abs(s) < 1 ? null : s > 0 ? 'ca' : 'es', score: s };
}

export interface LangSpan {
  start: number;
  end: number;
  lang: Lang;
  text: string;
}

/**
 * Splits a timed segment into same-language spans: clauses (split at punctuation) are scored,
 * clauses with no evidence take the language of their neighbours (or the fallback), and runs
 * are merged. Times are shared out in proportion to characters, so they are approximate.
 */
export function splitByLanguage(seg: { start: number; end: number; text: string }, fallback: Lang): LangSpan[] {
  const clauses = seg.text.match(/[^.?!;:,¿¡]+[.?!;:,]*|[¿¡][^.?!;:,]*[.?!;:,]*/g)?.filter((c) => c.trim()) ?? [];
  if (clauses.length === 0) return [];
  const langs: (Lang | null)[] = clauses.map((c) => scoreText(c).lang);
  // A clause with no evidence joins the previous labelled one, else the next, else fallback.
  for (let i = 0; i < langs.length; i++) {
    if (langs[i]) continue;
    const prev = langs.slice(0, i).reverse().find((l) => l);
    const next = langs.slice(i + 1).find((l) => l);
    langs[i] = prev ?? next ?? null;
  }
  const whole = scoreText(seg.text).lang ?? fallback;
  const total = clauses.reduce((n, c) => n + c.length, 0);
  const out: LangSpan[] = [];
  let at = 0;
  clauses.forEach((c, i) => {
    const lang = langs[i] ?? whole;
    const t0 = seg.start + ((seg.end - seg.start) * at) / total;
    at += c.length;
    const t1 = seg.start + ((seg.end - seg.start) * at) / total;
    const last = out[out.length - 1];
    if (last && last.lang === lang) {
      last.end = t1;
      last.text += c;
    } else out.push({ start: t0, end: t1, lang, text: c });
  });
  for (const s of out) s.text = s.text.trim();
  return out;
}
