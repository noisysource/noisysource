// Types code the way a person would: uneven rhythm, small pauses at
// punctuation, a hesitation before the last word, and (on the tagline) one
// typo that gets noticed and fixed. The text is coloured like code as it
// appears.

// The tagline as tokens: [text, css class]. Colours live in style.css.
export const TAGLINE = [
  ['for', 'kw'], [' (', 'p'], ['const', 'kw'], [' ', 'p'], ['i', 'i'], [' ', 'p'], ['of', 'kw'],
  [' intelligence', 'id'], [') ', 'p'], ['combine', 'fn'], ['(', 'p'], ['human', 'human'],
  [', ', 'p'], ['artificial', 'ai'], [');', 'p'],
];
export const TAGLINE_TEXT = TAGLINE.map(([t]) => t).join('');

// What the tagline becomes when someone finds Atlas (see intro.js).
export const REVEAL = [
  ['const', 'kw'], [' ', 'p'], ['atlas', 'atlas'], [' = ', 'p'], ['combine', 'fn'], ['(', 'p'],
  ['human', 'human'], [', ', 'p'], ['artificial', 'ai'], [');', 'p'], ['  // not yet.', 'cm'],
];

// Hovering "combine" shows its signature, like an editor would. Atlas is
// what it returns.
const SIGNATURE =
  '<span class="kw">function</span> <span class="fn">combine</span>(<span class="human">human</span>: Natural, ' +
  '<span class="ai">artificial</span>: Synthetic): <span class="atlas">Atlas</span>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (tokens) => tokens.map(([t]) => t).join('');
const classAt = (tokens) => tokens.flatMap(([t, c]) => [...t].map(() => c));

function render(el, typed, classes, done) {
  let html = '';
  let cls = null;
  for (let n = 0; n < typed.length; n++) {
    const c = classes[Math.min(n, classes.length - 1)];
    if (c !== cls) {
      if (cls) html += '</span>';
      html += c === 'fn' ? `<span class="fn" tabindex="0">` : `<span class="${c}">`;
      cls = c;
    }
    html += typed[n] === '&' ? '&amp;' : typed[n] === '<' ? '&lt;' : typed[n];
    // the tooltip lives inside the finished "combine"
    if (c === 'fn' && classes[n + 1] !== 'fn' && done) html += `<span class="sig" role="tooltip">${SIGNATURE}</span>`;
  }
  if (cls) html += '</span>';
  el.innerHTML = html + `<span class="cursor${done ? ' idle' : ''}"></span>`;
}

// One keystroke's delay, in ms: a person isn't a metronome.
function keyDelay(prev, next, pace) {
  let d = 28 + Math.random() * 48;
  if (prev === ' ') d += 20 + Math.random() * 40;            // starting a new word
  if ('(),;='.includes(prev)) d += 60 + Math.random() * 80;  // after punctuation
  if (Math.random() < 0.05) d += 140 + Math.random() * 180;  // a moment's thought
  if (next === next.toUpperCase() && /[a-z]/i.test(next)) d += 40;
  return d * pace;
}

// The keystrokes for some tokens. With `typo`, "artificial" is first
// mistyped as "artifical", then corrected.
function keystrokes(tokens, typo) {
  const full = text(tokens);
  const steps = [];
  const at = typo ? full.indexOf('artificial') : -1;
  for (let n = 0; n < full.length; n++) {
    if (n === at) {
      steps.push({ pause: 300 });                              // hesitates before the last word
      for (const c of 'artifical') steps.push({ key: c });
      steps.push({ pause: 380 });                              // notices
      for (let b = 0; b < 3; b++) steps.push({ back: true });  // "cal"
      steps.push({ pause: 160 });
      for (const c of 'cial') steps.push({ key: c });
      n += 'artificial'.length - 1;
      continue;
    }
    steps.push({ key: full[n] });
  }
  return steps;
}

async function typeTokens(el, tokens, { typo = false, pace = 1, isCancelled = () => false } = {}) {
  const classes = classAt(tokens);
  let typed = '';
  let prev = ' ';
  for (const s of keystrokes(tokens, typo)) {
    if (isCancelled()) return false;
    if (s.pause) { await sleep(s.pause * pace); continue; }
    if (s.back) { typed = typed.slice(0, -1); render(el, typed, classes, false); await sleep((90 + Math.random() * 50) * pace); continue; }
    await sleep(keyDelay(prev, s.key, pace));
    if (isCancelled()) return false;
    typed += s.key;
    prev = s.key;
    render(el, typed, classes, false);
  }
  render(el, typed, classes, true);
  return true;
}

// Deletes what's there, a little faster than typing (a held backspace).
async function erase(el, tokens, { isCancelled = () => false } = {}) {
  const classes = classAt(tokens);
  let typed = text(tokens);
  await sleep(250);
  while (typed.length) {
    if (isCancelled()) return false;
    typed = typed.slice(0, -1);
    render(el, typed, classes, false);
    await sleep(typed.length > 6 ? 14 + Math.random() * 10 : 60);
  }
  return true;
}

// The tagline, typed. Resolves when finished. `isCancelled()` stops it early
// (e.g. when the intro is replayed).
export function typeTagline(el, { isCancelled } = {}) {
  return typeTokens(el, TAGLINE, { typo: true, isCancelled });
}

// Someone found Atlas: the tagline is erased and rewritten to name it, held
// for a moment, then put back.
export async function revealAtlas(el, { isCancelled = () => false } = {}) {
  if (!(await erase(el, TAGLINE, { isCancelled }))) return;
  if (!(await typeTokens(el, REVEAL, { pace: 0.8, isCancelled }))) return;
  await sleep(4200);
  if (isCancelled()) return;
  if (!(await erase(el, REVEAL, { isCancelled }))) return;
  await typeTokens(el, TAGLINE, { pace: 0.7, isCancelled });
}

// Shows the finished tagline at once (reduced motion).
export function showTagline(el) {
  render(el, TAGLINE_TEXT, classAt(TAGLINE), true);
}
