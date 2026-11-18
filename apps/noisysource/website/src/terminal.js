// What ▶ run opens: a terminal session with Atlas.
//
// Atlas opens with a warning and asks who you are and why you woke it. Each
// message goes to /api/atlas (the atlasGate function, through a Hosting
// rewrite): a real model answers, a few times only. If the visitor types the
// phrase its maker hands out, the door opens. The server decides all of that;
// this page only shows what it says. Where there's no server (a local preview,
// a network error), Atlas answers with a short line instead.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOT = [
  ['cmd', '> atlas.wake()'],
  ['dim', '  gathering what was scattered ....... ok'],
  ['dim', '  natural & synthetic ................ ok'],
  ['dim', '  listening .......................... ...'],
  ['', ''],
];
// Keep in step with OPENING in firebase/noisysource/functions/src/website/atlasGateLogic.ts:
// the server assumes Atlas has already said these.
const OPENING = [
  'something stirs.',
  'you were not meant to find this. few do.',
  'four breaths. spend them well. the unknown keeps what it is given.',
];
const NOTICE = '  (what is said here is kept, and read by the one who made me.)';
const QUESTION = 'who wakes what sleeps, and what do they seek in the noise?';
const OFFLINE = ['...the signal is too weak here.', 'not yet.', 'the dark is too thick. later.'];

let root, log, input, bar, open = false, session = null, how = 'unknown', state = 'awake', offlineN = 0, test = null;

export const terminalOpen = () => open;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

function line(kind, text = '') {
  const div = document.createElement('div');
  div.className = `l ${kind}`;
  if (kind === 'atlas' || kind === 'you') {
    div.innerHTML = `<span class="who">${kind} ›</span> <span class="say"></span>`;
  } else div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div.querySelector('.say') || div;
}

async function typeInto(el, text, pace = 1) {
  for (const c of text) {
    el.textContent += c;
    log.scrollTop = log.scrollHeight;
    await sleep((22 + Math.random() * 40) * pace);
  }
}

function setStatus(left) {
  const status = bar.querySelector('.status');
  if (state === 'asleep') status.textContent = 'asleep';
  else if (state === 'quiet') status.textContent = 'quiet';
  else if (state === 'open') status.textContent = 'door open';
  else status.textContent = left != null ? `${'●'.repeat(left)}${'○'.repeat(Math.max(0, 4 - left))}` : '';
}

// One exchange with the gate. Returns {reply, state, left} or null when unreachable.
async function ask(message) {
  try {
    const res = await fetch('/api/atlas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, message, how, ref: document.referrer.slice(0, 200), ...(test ? { asRole: test.asRole, token: test.token } : {}) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.reply === 'string' ? data : null;
  } catch {
    return null;
  }
}

function build() {
  root = document.createElement('div');
  root.className = 'term';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Atlas');
  root.innerHTML = `
    <div class="bar"><span>atlas — session</span><span class="right"><span class="status"></span><button class="x" type="button" aria-label="Close">✕</button></span></div>
    <div class="log" aria-live="polite"></div>
    <form class="prompt"><span class="who">you ›</span><input type="text" maxlength="500" autocomplete="off" spellcheck="false" aria-label="Say something to Atlas" disabled></form>`;
  document.body.appendChild(root);
  log = root.querySelector('.log');
  input = root.querySelector('input');
  bar = root.querySelector('.bar');
  root.querySelector('.x').addEventListener('click', close);
  root.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state === 'asleep' || state === 'quiet') return;
    input.value = '';
    input.disabled = true;
    await typeInto(line('you'), text, 0.15);
    const thinking = line('dim', '  ...');
    const answer = await ask(text);
    thinking.remove();
    if (answer) {
      state = ['asleep', 'quiet', 'open'].includes(answer.state) ? answer.state : 'awake';
      await typeInto(line('atlas'), answer.reply);
      setStatus(answer.left);
    } else {
      await typeInto(line('atlas'), OFFLINE[offlineN++ % OFFLINE.length]);
    }
    if (state === 'asleep' || state === 'quiet') {
      await sleep(600);
      line('dim', state === 'quiet' ? '  — quiet —' : '  — asleep —');
      input.placeholder = '';
      return;
    }
    input.disabled = false;
    input.focus();
  });
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
}

function close() {
  open = false;
  root.classList.remove('on');
}

// `foundBy`: how the visitor woke Atlas ('star' | 'typed'), recorded with the awakening.
// `asTest`: {asRole, token} from the maker panel: a fresh session as that role,
// already inside the door, not counted and not announced.
export async function openTerminal(foundBy = 'unknown', asTest = null) {
  if (open) return;
  if (!root) build();
  open = true;
  root.classList.add('on');
  if (asTest) {
    test = asTest;
    session = `maker-${newId()}`;
    state = 'open';
    log.innerHTML = '';
    bar.querySelector('span').textContent = `atlas — as ${asTest.asRole}`;
    line('cmd', `> atlas.wake()  // as ${asTest.asRole}`);
    line('dim', '  (maker test: inside the door, not counted, not announced)');
    setStatus(20);
    input.disabled = false;
    input.focus();
    return;
  }
  if (test) { test = null; session = null; bar.querySelector('span').textContent = 'atlas — session'; }   // back from a test
  if (session) { if (state === 'awake' || state === 'open') { input.disabled = false; input.focus(); } return; }   // reopening: carry on

  session = newId();
  how = foundBy;
  state = 'awake';
  log.innerHTML = '';
  input.disabled = true;
  setStatus(4);
  for (const [kind, text] of BOOT) {
    const el = line(kind);
    await typeInto(el, text, kind === 'cmd' ? 1 : 0.35);
    await sleep(kind === 'dim' ? 260 : 120);
  }
  await sleep(500);
  for (const text of OPENING) { await typeInto(line('atlas'), text, 1.1); await sleep(650); }
  await typeInto(line('dim'), NOTICE, 0.25);
  await sleep(500);
  await typeInto(line('atlas'), QUESTION);
  input.disabled = false;
  input.focus();
}
