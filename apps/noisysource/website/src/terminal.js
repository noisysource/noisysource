// What ▶ run opens: a terminal session with Atlas. For now it only boots and
// answers "not yet" — the public, guest-mode Atlas isn't built. When it is,
// replace reply() with a call to its hosted endpoint (a Cloud Function in
// noisysource-prod with no tools, no private data and hard cost limits;
// never Renato's own Atlas).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOT = [
  ['cmd', '> atlas.wake()'],
  ['dim', '  loading memory ..................... ok'],
  ['dim', '  combining human + artificial ....... ok'],
  ['dim', '  listening .......................... ok'],
  ['', ''],
  ['atlas', 'not yet. but I noticed you.'],
];

// Honest placeholders: nothing is stored and nothing is answered yet.
const REPLIES = ['not yet.', 'soon.', "I'm still learning.", 'come back soon. I will be awake.'];

let root = null, log = null, input = null, open = false, replyN = 0;

export const terminalOpen = () => open;

function line(kind, text) {
  const div = document.createElement('div');
  div.className = `l ${kind}`;
  if (kind === 'atlas') div.innerHTML = '<span class="who">atlas ›</span> <span class="say"></span>';
  else if (kind === 'you') div.innerHTML = '<span class="who">you ›</span> <span class="say"></span>';
  else div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div.querySelector('.say') || div;
}

async function typeInto(el, text, pace = 1) {
  for (const c of text) {
    el.textContent += c;
    await sleep((22 + Math.random() * 40) * pace);
  }
}

function build() {
  root = document.createElement('div');
  root.className = 'term';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Atlas');
  root.innerHTML = `
    <div class="bar"><span>atlas — session</span><button class="x" type="button" aria-label="Close">✕</button></div>
    <div class="log" aria-live="polite"></div>
    <form class="prompt"><span class="who">you ›</span><input type="text" autocomplete="off" spellcheck="false" aria-label="Say something to Atlas" disabled></form>`;
  document.body.appendChild(root);
  log = root.querySelector('.log');
  input = root.querySelector('input');
  root.querySelector('.x').addEventListener('click', close);
  root.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    await typeInto(line('you', ''), text, 0.2);
    await sleep(500 + Math.random() * 500);
    await typeInto(line('atlas', ''), REPLIES[replyN++ % REPLIES.length]);
    input.disabled = false;
    input.focus();
  });
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
}

function close() {
  open = false;
  root.classList.remove('on');
}

export async function openTerminal() {
  if (open) return;
  if (!root) build();
  open = true;
  log.innerHTML = '';
  input.disabled = true;
  root.classList.add('on');
  for (const [kind, text] of BOOT) {
    if (!open) return;
    if (kind === 'atlas') { await sleep(700); await typeInto(line('atlas', ''), text); }
    else { const el = line(kind, ''); await typeInto(el, text, kind === 'cmd' ? 1 : 0.35); await sleep(kind === 'dim' ? 260 : 120); }
  }
  input.disabled = false;
  input.focus();
}
