// Types the tagline the way a person would: uneven rhythm, small pauses at
// punctuation, a hesitation before the last word, and one typo that gets
// noticed and fixed. The text is coloured like code as it appears.

// The tagline as tokens: [text, css class]. Colours live in style.css.
export const TAGLINE = [
  ['for', 'kw'], [' (', 'p'], ['const', 'kw'], [' ', 'p'], ['i', 'i'], [' ', 'p'], ['of', 'kw'],
  [' intelligence', 'id'], [') ', 'p'], ['combine', 'fn'], ['(', 'p'], ['human', 'human'],
  [', ', 'p'], ['artificial', 'ai'], [');', 'p'],
];
export const TAGLINE_TEXT = TAGLINE.map(([t]) => t).join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Class of the token covering each character of the final text.
const CLASS_AT = TAGLINE.flatMap(([t, c]) => [...t].map(() => c));

function render(el, text, done) {
  let html = '';
  let cls = null;
  for (let n = 0; n < text.length; n++) {
    const c = CLASS_AT[Math.min(n, CLASS_AT.length - 1)];
    if (c !== cls) { if (cls) html += '</span>'; html += `<span class="${c}">`; cls = c; }
    html += text[n] === '&' ? '&amp;' : text[n] === '<' ? '&lt;' : text[n];
  }
  if (cls) html += '</span>';
  el.innerHTML = html + `<span class="cursor${done ? ' idle' : ''}"></span>`;
}

// One keystroke's delay, in ms: a person isn't a metronome.
function keyDelay(prev, next) {
  let d = 38 + Math.random() * 65;
  if (prev === ' ') d += 30 + Math.random() * 60;            // starting a new word
  if ('(),;'.includes(prev)) d += 90 + Math.random() * 120;  // after punctuation
  if (Math.random() < 0.06) d += 180 + Math.random() * 260;  // a moment's thought
  if (next === next.toUpperCase() && /[a-z]/i.test(next)) d += 40;
  return d;
}

// The keystrokes: the tagline, with "artificial" first mistyped as
// "artifical", then corrected.
function keystrokes() {
  const steps = [];
  const typo = TAGLINE_TEXT.indexOf('artificial');
  for (let n = 0; n < TAGLINE_TEXT.length; n++) {
    if (n === typo) {
      steps.push({ pause: 420 });                              // hesitates before the last word
      for (const c of 'artifical') steps.push({ key: c });
      steps.push({ pause: 520 });                              // notices
      for (let b = 0; b < 3; b++) steps.push({ back: true });  // "cal"
      steps.push({ pause: 160 });
      for (const c of 'cial') steps.push({ key: c });
      n += 'artificial'.length - 1;
      continue;
    }
    steps.push({ key: TAGLINE_TEXT[n] });
  }
  return steps;
}

// Types into `el`. Resolves when finished. `isCancelled()` stops it early
// (e.g. when the intro is replayed).
export async function typeTagline(el, { isCancelled = () => false } = {}) {
  let text = '';
  render(el, text, false);
  let prev = ' ';
  for (const s of keystrokes()) {
    if (isCancelled()) return;
    if (s.pause) { await sleep(s.pause); continue; }
    if (s.back) { text = text.slice(0, -1); render(el, text, false); await sleep(90 + Math.random() * 50); continue; }
    await sleep(keyDelay(prev, s.key));
    if (isCancelled()) return;
    text += s.key;
    prev = s.key;
    render(el, text, false);
  }
  render(el, text, true);
}

// Shows the finished tagline at once (reduced motion).
export function showTagline(el) {
  render(el, TAGLINE_TEXT, true);
}
