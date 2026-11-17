// The lines typed out under the shape. Edit freely.
const LINES = ['something is learning.', 'signal acquired.', 'it remembers.', 'not yet.', 'soon.'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startTypewriter(el, lines = LINES) {
  let i = 0;
  await sleep(800);
  for (;;) {
    const s = lines[i++ % lines.length];
    for (let n = 1; n <= s.length; n++) { el.textContent = s.slice(0, n); await sleep(70 + Math.random() * 60); }
    await sleep(3200);
    for (let n = s.length; n >= 0; n--) { el.textContent = s.slice(0, n); await sleep(28); }
    await sleep(900);
  }
}
