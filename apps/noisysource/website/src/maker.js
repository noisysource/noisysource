// The maker panel: open the site with #maker. Only works with the panel token
// (adminToken in atlas_gate/config); without it the server answers "no." and
// nothing is shown. Lets the maker:
//   - switch, per role, which knowledge blocks Atlas may talk about,
//   - write those blocks,
//   - hand out personal keys (a phrase that opens the door as a role),
//   - talk to Atlas as any role, to test (not counted, not announced).
// Everything is read and saved through /api/atlas (atlasGate), which checks
// the token and re-validates the matrix. Keep in step with TOPICS / ROLES in
// firebase/noisysource/functions/src/website/atlasGateLogic.ts.

import { openTerminal } from './terminal.js';

const TOPICS = [
  ['profile', 'profile'],
  ['infrastructure', 'infra & code'],
  ['business', 'business model'],
  ['product', 'product'],
  ['apps', 'other apps'],
];
const TOPIC_HINTS = {
  profile: "the maker's profile and experience (for recruiters, typically)",
  infrastructure: 'infrastructure, code and architecture',
  business: 'the business model, the vision, how it grows',
  product: 'the product: what Atlas does for people',
  apps: 'the other apps (KidClub and the rest)',
};
const ROLES = ['recruiter', 'investor', 'manager', 'colleague', 'curious', 'other'];
const STORE = 'atlas-maker';

let root = null, access = null, token = '';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function api(body) {
  const res = await fetch('/api/atlas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token }) });
  if (res.status === 403) throw new Error('no.');
  if (!res.ok) throw new Error(`error ${res.status}`);
  return res.json();
}

function status(text) { root.querySelector('.mk-status').textContent = text; }

function renderLogin(msg = '') {
  root.querySelector('.mk-body').innerHTML = `
    <form class="mk-login">
      <label>token <input type="password" autocomplete="off" spellcheck="false"></label>
      <button type="submit">enter</button>
      <span class="mk-msg">${esc(msg)}</span>
    </form>`;
  const form = root.querySelector('.mk-login');
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    token = form.querySelector('input').value.trim();
    await load();
  });
}

async function load() {
  status('…');
  try {
    access = (await api({ action: 'access.get' })).access;
    try { sessionStorage.setItem(STORE, token); } catch { /* private mode */ }
    renderPanel();
    status('');
  } catch (err) {
    try { sessionStorage.removeItem(STORE); } catch { /* */ }
    token = '';
    renderLogin(err.message);
    status('');
  }
}

function renderPanel() {
  const on = (r, t) => (access.roles[r] ?? []).includes(t);
  root.querySelector('.mk-body').innerHTML = `
    <section>
      <h3>what each role may hear</h3>
      <table class="mk-grid">
        <tr><th></th>${TOPICS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>
        ${ROLES.map((r) => `<tr><td>${r}</td>${TOPICS.map(([t]) => `<td><input type="checkbox" data-role="${r}" data-topic="${t}" ${on(r, t) ? 'checked' : ''} aria-label="${r} may hear ${t}"></td>`).join('')}</tr>`).join('')}
      </table>
      <p class="mk-note">strangers (no words yet) never hear any of it. with the shared phrase, the role is Atlas's guess; with a personal key, it's the key's role.</p>
    </section>
    <section>
      <h3>what Atlas knows</h3>
      ${TOPICS.map(([t, l]) => `<label class="mk-topic"><span>${l} <em>${esc(TOPIC_HINTS[t])}</em></span><textarea data-topic="${t}" rows="4" spellcheck="false" placeholder="nothing yet">${esc(access.topics[t] ?? '')}</textarea></label>`).join('')}
      <p class="mk-note">never put your name here. Atlas is told never to say it, but the safest name is one it doesn't have.</p>
    </section>
    <section>
      <h3>personal keys</h3>
      <div class="mk-keys">${access.keys.map(keyRow).join('')}</div>
      <button type="button" class="mk-add">+ key</button>
    </section>
    <section class="mk-actions">
      <button type="button" class="mk-save">save</button>
      <span class="mk-test">talk as <select>${ROLES.map((r) => `<option>${r}</option>`).join('')}</select><button type="button" class="mk-talk">talk</button></span>
    </section>`;
  const body = root.querySelector('.mk-body');
  body.querySelector('.mk-add').addEventListener('click', () => {
    body.querySelector('.mk-keys').insertAdjacentHTML('beforeend', keyRow({ phrase: '', role: 'investor', label: '', enabled: true }));
  });
  body.querySelector('.mk-keys').addEventListener('click', (e) => {
    if (e.target.closest('.mk-del')) e.target.closest('.mk-key').remove();
  });
  body.querySelector('.mk-save').addEventListener('click', save);
  body.querySelector('.mk-talk').addEventListener('click', () => {
    const role = body.querySelector('.mk-test select').value;
    close();
    openTerminal('maker', { asRole: role, token });
  });
}

function keyRow(k) {
  return `<div class="mk-key">
    <input class="k-phrase" placeholder="the words" value="${esc(k.phrase)}" spellcheck="false" autocomplete="off">
    <select class="k-role">${ROLES.map((r) => `<option ${r === k.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <input class="k-label" placeholder="who got it (private)" value="${esc(k.label)}" spellcheck="false">
    <label class="k-on"><input type="checkbox" ${k.enabled ? 'checked' : ''}> on</label>
    <button type="button" class="mk-del" aria-label="Remove key">✕</button>
  </div>`;
}

async function save() {
  const body = root.querySelector('.mk-body');
  const next = { topics: {}, roles: {}, keys: [] };
  for (const ta of body.querySelectorAll('textarea[data-topic]')) next.topics[ta.dataset.topic] = ta.value;
  for (const r of ROLES) next.roles[r] = [];
  for (const cb of body.querySelectorAll('.mk-grid input:checked')) next.roles[cb.dataset.role].push(cb.dataset.topic);
  for (const row of body.querySelectorAll('.mk-key')) {
    const phrase = row.querySelector('.k-phrase').value.trim();
    if (!phrase) continue;
    next.keys.push({ phrase, role: row.querySelector('.k-role').value, label: row.querySelector('.k-label').value.trim(), enabled: row.querySelector('.k-on input').checked });
  }
  status('saving…');
  try {
    access = (await api({ action: 'access.set', access: next })).access;
    renderPanel();
    status('saved.');
  } catch (err) { status(err.message); }
}

function build() {
  root = document.createElement('div');
  root.className = 'maker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Maker');
  root.innerHTML = `
    <div class="mk-bar"><span>maker</span><span class="mk-right"><span class="mk-status"></span><button type="button" class="mk-x" aria-label="Close">✕</button></span></div>
    <div class="mk-body"></div>`;
  document.body.appendChild(root);
  root.querySelector('.mk-x').addEventListener('click', close);
}

function close() {
  root?.classList.remove('on');
  if (location.hash === '#maker') history.replaceState(null, '', location.pathname + location.search);
}

async function open() {
  if (!root) build();
  root.classList.add('on');
  if (access) return;
  try { token = sessionStorage.getItem(STORE) || ''; } catch { token = ''; }
  if (token) await load(); else renderLogin();
}

export function startMaker() {
  const check = () => { if (location.hash === '#maker') open(); };
  window.addEventListener('hashchange', check);
  check();
}
