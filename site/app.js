/* Board — client. Everything is a selector-addressed HTTP write against the
   board document. No framework, no state store: the DOM is the state, and the
   server document is the DOM. */

/* ---------- fragment client ---------- */
const PL = {
  async req(method, path, o = {}) {
    const h = {};
    if (o.sel) h.Range = 'selector=' + o.sel + (o.placement && method === 'POST' ? '; placement=' + o.placement : '');
    if (o.destSel) {
      h.Destination = path;
      h['Destination-Range'] = 'selector=' + o.destSel + '; placement=' + o.placement;
    }
    if (o.body != null) h['Content-Type'] = 'text/html';
    const r = await fetch(path, { method, headers: h, body: o.body });
    if (!r.ok) throw new Error(method + ' ' + (o.sel || path) + ' → ' + r.status);
    if (method !== 'GET' && PL.onWrite) PL.onWrite();
    return r;
  },
  put:  (p, sel, body)                 => PL.req('PUT',    p, { sel, body }),
  post: (p, sel, body, placement)      => PL.req('POST',   p, { sel, body, placement }),
  del:  (p, sel)                       => PL.req('DELETE', p, { sel }),
  move: (p, sel, destSel, placement)   => PL.req('MOVE',   p, { sel, destSel, placement }),
  onWrite: null,
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* MOVE, confirmed.

   Two concurrent MOVEs against the same document lose one of them roughly
   three times in four on this build: the server answers 204 but the element
   never leaves its old parent. If-Match would be the usual guard, but
   conditional writes reject every request here — even If-Match: * — so there
   is nothing to compare against. Instead, read the destination back and repeat
   until the element is actually in it. Serialised retries converge; measured
   over 12 concurrent pairs this took the loss rate from 9/12 to 0/12.

   Membership is what gets lost, so membership is what is verified. Exact
   position within a list stays last-write-wins, which the brief allows. */
async function moveVerified(path, id, destSel, placement, containerSel) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await PL.move(path, '#' + id, destSel, placement);
    const r = await PL.req('GET', path + '?v=' + Date.now(), { sel: containerSel });
    if ((await r.text()).includes('id="' + id + '"')) return;
    await new Promise(r => setTimeout(r, 60 + Math.random() * 180));
  }
  throw new Error('move of ' + id + ' would not stick');
}

/* Replace an element, or create it if it isn't there yet. PUT only replaces
   what already exists, so a selector that matches nothing (416) means this is
   the first write and the element gets appended to its container instead. */
async function upsert(path, containerSel, sel, html) {
  try {
    await PL.put(path, sel, html);
  } catch (err) {
    if (!/→ 416$/.test(err.message)) throw err;
    await PL.post(path, containerSel, html, 'append');
  }
}

/* Write one field of a record — always a single element, never the whole
   parent, so a one-field change can't clobber a concurrent edit elsewhere. */
const setField = (path, ownerSel, field, value) =>
  upsert(path, ownerSel, ownerSel + ' [data-f="' + field + '"]', metaHTML(field, value));
const uid = p => p + '-' + Math.random().toString(36).slice(2, 9);
const BG = ['ocean', 'forest', 'berry', 'dusk', 'sand', 'slate', 'teal', 'pink'];

/* Shared handles the board's pieces use to reach each other. Populated by
   initBoard; the no-op defaults keep the home page from tripping over them. */
const boardCtx = { openCard() {}, refreshModal() {}, openCardId: () => null, openEpic() {},
                   refreshLabelFilter() {}, memberFilter: null, labelFilter: null };

let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

/* Face titles live inside draggable elements, and a contenteditable at rest
   swallows the mouse-down that should start the drag — Chrome begins a text
   selection instead. So titles are static until a rename affordance switches
   editing on, and blur switches it back off. */
function editOnDemand(el) {
  el.setAttribute('contenteditable', 'plaintext-only');
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  el.addEventListener('blur', () => el.removeAttribute('contenteditable'), { once: true });
}

/* Inline-editable text: commit on blur, Enter commits, Escape reverts. */
function editable(el, commit) {
  let before = el.textContent;
  el.addEventListener('focus', () => { before = el.textContent; });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.textContent = before; el.blur(); }
  });
  el.addEventListener('blur', async () => {
    const now = el.textContent.trim();
    if (!now) { el.textContent = before; return; }
    if (now === before) return;
    el.textContent = now;
    try { await commit(now); before = now; }
    catch (err) { el.textContent = before; toast('Could not save: ' + err.message); }
  });
}

/* ---------------------------------------------------------------
   Identity.

   A placeholder until WorkOS OIDC is wired up. Once it is, this is the only
   function that changes: sub/name/picture come from request.auth.claims and
   the localStorage fallback goes away. Everything downstream already keys off
   an opaque `sub`, never an email.
   --------------------------------------------------------------- */
/* No identity is invented for you any more: a browser without a saved
   profile gets null, and the board gates on setting one up. */
function whoami() {
  try { return JSON.parse(localStorage.getItem('board:me') || 'null'); } catch (_) { return null; }
}

/* The server renders the OIDC session's claims into #whoami-server on every
   request (empty when anonymous). A logged-in identity always wins over any
   local profile — this is the bridge that associates the Zitadel account
   with the board: the sub flows into the member registry, presence, and
   every write attribution from here on. */
function serverIdentity() {
  const el = document.getElementById('whoami-server');
  if (!el) return null;
  const [sub, name, email, picture, roles] = el.textContent.split('|').map(s => s.trim());
  if (!sub) return null;
  /* Roles are surfaced so access can later be scoped to a Zitadel role
     rather than "anyone this instance authenticates" — Pagelove maps an
     OIDC role straight onto an AuthorizationRule actor. */
  return { sub, name: name || email || sub, picture: picture || '',
           roles: roles ? roles.split(/\s+/).filter(Boolean) : [] };
}

/* Before touching a board you say who you are. A live OIDC session answers
   that outright; otherwise a name typed once per device. The sign-in button
   appears whenever the host has a login path to offer. */
function requireProfile() {
  const oidc = serverIdentity();
  const prev = whoami() || {};
  if (oidc) {
    /* Zitadel only sends name/email claims when the application's token
       settings say so; until then the only claim is the numeric sub. A
       number is not a name, so in that case the person is asked what to
       call them — once — while their real sub is kept underneath. */
    const claimedName = oidc.name && oidc.name !== oidc.sub ? oidc.name : '';
    const knownName = prev.sub === oidc.sub && prev.name && prev.name !== oidc.sub ? prev.name : '';
    const name = claimedName || knownName;
    if (name) {
      const me = { sub: oidc.sub, name, picture: oidc.picture || prev.picture || '' };
      localStorage.setItem('board:me', JSON.stringify(me));
      return Promise.resolve(me);
    }
    return askForName(oidc);
  }
  const existing = whoami();
  if (existing && existing.name) return Promise.resolve(existing);
  /* Not signed in and no saved profile: there is no guest path any more.
     The server denies anonymous reads anyway; this is the client half. */
  location.href = '/auth/login';
  return new Promise(() => {});   /* the navigation ends this page */
}

/* One dialog serves both gates: an anonymous visitor is offered sign-in
   first with a typed name as fallback; a signed-in-but-nameless session
   (claims withheld) is only asked what to call them. */
function askForName(oidc) {
  return new Promise(resolve => {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="welcome-dialog">
      <form method="dialog">
        <h3>${oidc ? 'One more thing' : 'Welcome to Board'}</h3>
        ${oidc ? '<p class="welcome-sub">You\u2019re signed in, but your account didn\u2019t share a name. What should we call you?</p>'
               : '<p class="welcome-sub"><a class="btn-primary welcome-login" href="/auth/login">Sign in</a></p><p class="welcome-sub">Or just tell us your name, so it shows on the cards you touch.</p>'}
        <input type="text" name="name" placeholder="Your name" autocomplete="name" required>
        <div class="profile-row">
          <span class="profile-preview"></span>
          <label class="btn-ghost">Add a photo<input type="file" name="photo" accept="image/*" hidden></label>
        </div>
        <div class="dialog-actions"><button class="btn-primary" type="submit" value="save">Start</button></div>
      </form>
    </dialog>`);
    const dlg = document.getElementById('welcome-dialog');
    const sub = oidc ? oidc.sub : uid('u');
    let picture = (oidc && oidc.picture) || '';
    dlg.showModal();
    dlg.querySelector('[name=photo]').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const url = '/uploads/avatars/' + sub + '-' + f.name.replace(/[^\w.-]+/g, '_');
      try {
        const up = await fetch(url, { method: 'PUT', headers: { 'Content-Type': f.type || 'image/jpeg' }, body: f });
        if (!up.ok) throw 0;
        picture = url;
        dlg.querySelector('.profile-preview').innerHTML = `<img class="avatar avatar-img" src="${esc(url)}" alt="">`;
      } catch (_) { toast('Could not upload photo'); }
    });
    dlg.querySelector('form').addEventListener('submit', e => {
      const name = dlg.querySelector('[name=name]').value.trim();
      if (!name) { e.preventDefault(); return; }
      const me = { sub, name, picture };
      localStorage.setItem('board:me', JSON.stringify(me));
      dlg.remove();
      resolve(me);
    });
  });
}

/* A stable colour per person, derived from the sub so it survives renames. */
function subColour(sub) {
  let h = 0;
  for (const ch of sub) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return 'hsl(' + h + ' 52% 42%)';
}

const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* Every avatar goes through here. A member who has set a photo gets it;
   everyone else gets initials on their stable colour. The lookup is by sub
   against the board's member registry, so a photo set once shows everywhere
   that person appears — presence, card fronts, pickers, comments. */
function avatarHTML(sub, name, cls) {
  const rec = sub && document.querySelector('#members [data-sub="' + sub + '"]');
  const label = esc(name || (rec && rec.getAttribute('data-name')) || sub || '?');
  const pic = rec && rec.getAttribute('data-picture');
  if (pic) return `<img class="${cls} avatar-img" src="${esc(pic)}" alt="${label}" title="${label}">`;
  return `<span class="${cls}" style="background:${subColour(sub || label)}" title="${label}">${esc(initials(name || label))}</span>`;
}

/* ---------------------------------------------------------------
   Live sync.

   Server-Sent Events drive it: the platform streams a mutation event to
   every subscriber EXCEPT the originator — which is exactly right for us,
   since our own writes are already applied optimistically. (An early build
   of this file polled every 3s in the belief the stream was dead; the truth
   was originator suppression plus a test that never properly isolated the
   principals.) An event just kicks a debounced re-read of the document, so
   all the reconcile and don't-yank-the-user logic stays exactly as it was.
   A slow fallback poll covers a silently dead stream.
   --------------------------------------------------------------- */
const SYNC_FALLBACK_MS = 30000;
const APP_VERSION = '1789423173';

/* A tab left open for days keeps running the JavaScript it first loaded — the
   platform serves assets with a fixed 5-minute cache and no override, so new
   deploys never reach a long-lived tab on their own. The app checks a tiny
   version marker periodically; when it changes, it offers a reload once
   rather than letting the tab rot on stale code (which is what "persistent
   lag after a fix" always turns out to be). */
let versionNagged = false;
async function checkVersion() {
  if (versionNagged) return;
  try {
    const v = (await (await fetch('/version.txt?v=' + Date.now(), { cache: 'no-store' })).text()).trim();
    if (v && v !== APP_VERSION) {
      versionNagged = true;
      const bar = document.createElement('div');
      bar.id = 'update-bar';
      bar.innerHTML = 'A new version of Board is available. <button type="button">Reload</button>';
      bar.querySelector('button').onclick = () => location.reload();
      document.body.appendChild(bar);
    }
  } catch (_) {}
}
setInterval(checkVersion, 60000);

const PRESENCE_MS = 10000;
const PRESENCE_STALE_MS = 30000;

function startSync(path, ctx) {
  let pending = null;      /* a remote document held back while the user works */
  let quietUntil = 0;      /* our own writes need a moment to become readable */
  let lastWriteAt = 0;     /* no snapshot older than this may be applied */
  let kick = () => {};     /* reassigned below, once the stream is wired */

  PL.onWrite = () => {
    lastWriteAt = Date.now();
    quietUntil = lastWriteAt + 1200;
    /* Our own writes come back on no stream (originator suppression), so
       reconvergence after a write is self-served rather than left to the
       fallback poll. */
    kick();
  };

  /* Never apply a remote change on top of someone mid-gesture. Anything that
     arrives while dragging or typing is parked and applied on release. */
  const busy = () => {
    if (ctx.dragging()) return true;
    const a = document.activeElement;
    return !!a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  };

  async function pull() {
    if (Date.now() < quietUntil) return;
    const startedAt = Date.now();
    let doc;
    try {
      const r = await fetch(path + '?sync=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    } catch (_) { return; }
    doc._fetchedAt = startedAt;

    if (busy()) { pending = doc; return; }
    apply(doc);
  }

  function apply(doc) {
    pending = null;
    /* A snapshot fetched before our latest write completed predates what the
       user already sees. Applying it would delete their optimistic card and
       hand it back much later — the reconciler treats absence as deletion.
       Discard it and read again instead. */
    if ((doc._fetchedAt || 0) < lastWriteAt) { kick(); return; }

    /* The archive has to be synced before the lists are. Archiving moves a
       card out of #lists, so a poll that started before the write still shows
       it in a list; without this the reconciler would pull it back, and the
       next poll — seeing it in neither the remote lists nor anywhere it knows
       about — would delete it from view while the server still had it. */
    const remoteArchive = doc.getElementById('archive');
    const localArchive = document.getElementById('archive');
    if (remoteArchive && localArchive && remoteArchive.innerHTML !== localArchive.innerHTML) {
      localArchive.innerHTML = remoteArchive.innerHTML;
      renderArchive(location.pathname);
    }

    const remoteGA = doc.getElementById('goals-archive');
    const localGA = document.getElementById('goals-archive');
    if (remoteGA && localGA && remoteGA.innerHTML !== localGA.innerHTML) localGA.innerHTML = remoteGA.innerHTML;
    else if (remoteGA && !localGA) document.body.appendChild(remoteGA.cloneNode(true));

    const remoteGoalsC = doc.getElementById('goals');
    const localGoalsC = document.getElementById('goals');
    if (remoteGoalsC && localGoalsC && remoteGoalsC.innerHTML !== localGoalsC.innerHTML) {
      localGoalsC.innerHTML = remoteGoalsC.innerHTML;
      boardCtx.paintGoals?.();
    } else if (remoteGoalsC && !localGoalsC) {
      document.body.appendChild(remoteGoalsC.cloneNode(true));
      boardCtx.paintGoals?.();
    }

    /* Board-level registries are replaced whole when they differ, like goals.
       Nothing edits inside them in place — the pickers live in the modal — so
       a replace can't pull an input out from under anyone. Card fronts are
       redrawn afterwards because the names and epics they show live here. */
    let registriesChanged = false;
    for (const id of ['labels', 'members', 'epics']) {
      const r = doc.getElementById(id), l = document.getElementById(id);
      if (r && l && r.innerHTML !== l.innerHTML) { l.innerHTML = r.innerHTML; registriesChanged = true; }
    }
    const remoteLists = doc.getElementById('lists');
    if (remoteLists) { reconcileLists(remoteLists, ctx); boardCtx.applyFilter?.(); }
    if (registriesChanged) document.querySelectorAll('#lists .card').forEach(renderCardFront);
    const remotePresence = doc.getElementById('presence');
    if (remotePresence) renderPresence(remotePresence);
    const remoteActs = doc.getElementById('activity');
    const localActs = document.getElementById('activity');
    if (remoteActs && localActs && remoteActs.innerHTML !== localActs.innerHTML) {
      localActs.innerHTML = remoteActs.innerHTML;
      renderActivity();
      if (boardCtx.openCardId()) boardCtx.refreshModal();
    }
  }

  const flush = () => { if (pending && !busy()) apply(pending); };
  document.addEventListener('focusout', () => setTimeout(flush, 0));
  document.addEventListener('dragend', () => setTimeout(flush, 0));

  /* A burst of events (a drag is a MOVE plus field writes) collapses into
     one read; a kick that lands inside our own post-write quiet window
     re-arms itself rather than reading stale state. */
  let kickT = null;
  kick = () => {
    clearTimeout(kickT);
    kickT = setTimeout(() => {
      if (Date.now() < quietUntil) return kick();
      pull();
    }, 250);
  };

  boardCtx.resync = kick;

  const es = new EventSource(path);
  es.addEventListener('mutation', kick);
  es.addEventListener('reset', () => pull());
  /* onerror: EventSource reconnects on its own; the fallback poll rides
     over any gap it can't close. */

  setInterval(pull, SYNC_FALLBACK_MS);
  pull();
}

/* Reconcile the live board against a freshly-read one, moving the existing
   nodes rather than reinnerHTML-ing the column — that would destroy scroll
   position, selection, and every listener on the page. */
function reconcileLists(remote, ctx) {
  const local = document.getElementById('lists');
  const rLists = [...remote.children].filter(el => el.classList.contains('list'));
  const keepLists = new Set(rLists.map(l => l.id));

  [...local.children].forEach(l => { if (!keepLists.has(l.id)) l.remove(); });

  /* Cards are matched across the whole board, not per column, so a card that
     someone else dragged to another list is moved rather than destroyed and
     rebuilt. */
  /* Only cards under #lists are candidates for removal, and only when the
     remote lists no longer carry them — an archived card has already been
     placed in #archive by the caller, so dropping the stale copy here is
     correct rather than destructive. */
  const keepCards = new Set([...remote.querySelectorAll('.card')].map(c => c.id));
  document.querySelectorAll('#lists .card').forEach(c => { if (!keepCards.has(c.id)) c.remove(); });

  rLists.forEach((rl, i) => {
    let ll = document.getElementById(rl.id);
    if (!ll) {
      ll = rl.cloneNode(true);
      ll.querySelectorAll('.card').forEach(c => c.remove());
      local.appendChild(ll);
      ctx.wireList(ll);
    }
    if (local.children[i] !== ll) local.insertBefore(ll, local.children[i] || null);

    syncText(ll.querySelector('.list-title'), rl.querySelector('.list-title'));

    const lCards = ll.querySelector('.cards');
    const rCards = [...rl.querySelectorAll('.card')];
    rCards.forEach((rc, j) => {
      let lc = document.getElementById(rc.id);
      if (!lc) { lc = rc.cloneNode(true); lCards.appendChild(lc); ctx.wireCard(lc); }
      else { syncText(lc.querySelector('.card-title'), rc.querySelector('.card-title')); syncCardFields(lc, rc); }
      if (lCards.children[j] !== lc) lCards.insertBefore(lc, lCards.children[j] || null);
    });
  });
}

/* Bring a card's own fields up to date with the server's copy, then repaint
   its face. Meta fields carry no focus, so they are always safe to overwrite;
   the description is skipped while it is being edited. */
function syncCardFields(local, remote) {
  let changed = false;
  remote.querySelectorAll(':scope > [data-f]').forEach(rf => {
    const f = rf.getAttribute('data-f');
    if (f === 'card-title') return;
    let lf = local.querySelector(':scope > [data-f="' + f + '"]');
    if (!lf) { local.appendChild(rf.cloneNode(true)); changed = true; return; }
    if (rf.tagName === 'META') {
      if (lf.getAttribute('content') !== rf.getAttribute('content')) {
        lf.setAttribute('content', rf.getAttribute('content') || '');
        changed = true;
      }
    } else if (lf.textContent !== rf.textContent && document.activeElement?.className !== 'desc-edit') {
      lf.textContent = rf.textContent;
      changed = true;
    }
  });
  /* Checklists and comments are collections, not fields: sync the whole
     container when it differs. Comments only ever grow, so this is additive in
     practice, and the modal is redrawn from it afterwards. */
  for (const cls of ['checklists', 'comments', 'attachments']) {
    const rc = remote.querySelector('.' + cls), lc = local.querySelector('.' + cls);
    if (rc && lc && rc.innerHTML !== lc.innerHTML) { lc.innerHTML = rc.innerHTML; changed = true; }
    else if (rc && !lc) { local.appendChild(rc.cloneNode(true)); changed = true; }
  }

  if (changed) {
    renderCardFront(local);
    if (boardCtx.openCardId && boardCtx.openCardId() === local.id) boardCtx.refreshModal();
  }
}

/* Text only changes when the person isn't in the middle of editing it. */
function syncText(localEl, remoteEl) {
  if (!localEl || !remoteEl) return;
  if (document.activeElement === localEl) return;
  if (localEl.textContent !== remoteEl.textContent) localEl.textContent = remoteEl.textContent;
}

/* ---------------------------------------------------------------
   Presence — who else has this board open. No cursors.
   --------------------------------------------------------------- */
function startPresence(path, me) {
  const sel = '#V-' + me.sub;
  const el = () => `<span class="viewer" id="V-${me.sub}" data-sub="${esc(me.sub)}" data-name="${esc(me.name)}" data-seen="${Date.now()}"></span>`;

  const beat = async () => {
    try {
      await upsert(path, '#presence', sel, el());
    } catch (_) {
      /* Board documents written before presence existed have no container. */
      try {
        await PL.post(path, 'body', '<div hidden id="presence"></div>', 'append');
        await upsert(path, '#presence', sel, el());
      } catch (_) { /* presence is best-effort */ }
    }
  };
  beat();
  setInterval(beat, PRESENCE_MS);

  /* Leaving is a courtesy, not a guarantee — stale viewers age out anyway. */
  addEventListener('pagehide', () => {
    fetch(path, { method: 'DELETE', headers: { Range: 'selector=' + sel }, keepalive: true }).catch(() => {});
  });
}

function renderPresence(remotePresence) {
  const me = whoami();
  const box = document.getElementById('avatars');
  if (!box) return;
  const now = Date.now();
  const live = [...remotePresence.querySelectorAll('.viewer')]
    .filter(v => now - Number(v.dataset.seen || 0) < PRESENCE_STALE_MS)
    .filter(v => v.dataset.sub !== me.sub);

  const on = boardCtx.memberFilter;
  const face = (sub, name, cls, label) =>
    `<button class="avatar-btn${on === sub ? ' is-filtering-by' : ''}" type="button" ` +
    `data-sub="${esc(sub)}" title="${esc(label)}">${avatarHTML(sub, name, cls)}</button>`;

  box.innerHTML =
    live.map(v => face(v.dataset.sub, v.dataset.name,
      'avatar', (on === v.dataset.sub ? 'Showing ' : 'Show only ') + v.dataset.name + '\u2019s cards')).join('') +
    face(me.sub, me.name, 'avatar avatar-me',
      on === me.sub ? 'Showing your cards \u2014 click to show all' : 'Show only your cards');
}

/* ============================ HOME ============================ */
function initHome() {
  const path = '/index.html';
  const grid = document.getElementById('boards');
  const dlg = document.getElementById('new-board-dialog');

  document.getElementById('new-board-btn').onclick = () => dlg.showModal();

  dlg.querySelector('form').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const name = dlg.querySelector('[name=name]').value.trim() || 'Untitled board';
    const bg = dlg.querySelector('[name=bg]:checked').value;
    const id = uid('b');
    const docPath = '/boards/' + id + '.html';
    try {
      await PL.req('PUT', docPath, { body: boardDoc(id, name, bg) });
      await PL.post(path, '#boards', tileHTML(id, name, bg), 'prepend');
      location.href = docPath;
    } catch (err) { toast('Could not create board: ' + err.message); }
    dlg.close();
  });

  grid.addEventListener('click', async e => {
    const tile = e.target.closest('.board-tile');
    if (!tile) return;
    const id = tile.dataset.board;

    if (e.target.closest('.star')) {
      e.preventDefault();
      const btn = e.target.closest('.star');
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      try { await setField(path, '#' + id, 'starred', on); }
      catch (err) { btn.setAttribute('aria-pressed', String(!on)); toast('Could not star: ' + err.message); }
      reflow();
    }

    if (e.target.closest('.tile-restore')) {
      e.preventDefault();
      grid.appendChild(tile);
      try { await moveVerified(path, id, '#boards', 'append', '#boards'); }
      catch (err) { document.getElementById('archived-boards').appendChild(tile); toast('Could not restore: ' + err.message); }
      reflow();
      return;
    }

    if (e.target.closest('.tile-archive')) {
      e.preventDefault();
      const prev = tile.nextElementSibling;
      const arch = document.getElementById('archived-boards');
      arch.appendChild(tile);
      try { await moveVerified(path, id, '#archived-boards', 'append', '#archived-boards'); }
      catch (err) { grid.insertBefore(tile, prev); toast('Could not archive: ' + err.message); }
      reflow();
    }
  });

  document.getElementById('archived-boards').addEventListener('click', async e => {
    const tile = e.target.closest('.board-tile');
    if (!tile || !e.target.closest('.tile-restore')) return;
    e.preventDefault();
    grid.appendChild(tile);
    try { await moveVerified(path, tile.dataset.board, '#boards', 'append', '#boards'); }
    catch (err) { document.getElementById('archived-boards').appendChild(tile); toast('Could not restore: ' + err.message); }
    reflow();
  });

  /* Starred boards float to the top of the grid (display only, not persisted). */
  function reflow() {
    document.querySelectorAll('.board-tile').forEach(t => {
      const f = t.querySelector('[data-f="bg"]');
      if (f && f.getAttribute('content')) t.dataset.bg = f.getAttribute('content');
      const archived = t.parentElement.id === 'archived-boards';
      const btn = t.querySelector('.tile-archive, .tile-restore');
      if (btn) {
        btn.className = archived ? 'tile-restore' : 'tile-archive';
        btn.textContent = archived ? 'Restore' : 'Archive';
      }
    });
    [...grid.children]
      .sort((a, b) => (b.querySelector('.star').getAttribute('aria-pressed') === 'true') -
                      (a.querySelector('.star').getAttribute('aria-pressed') === 'true'))
      .forEach(n => grid.appendChild(n));
    document.getElementById('archived-section').hidden =
      !document.getElementById('archived-boards').children.length;
    document.getElementById('empty-note').hidden = grid.children.length > 0;
  }
  reflow();
}

const metaHTML = (f, v) => `<meta data-f="${f}" content="${esc(v)}">`;

const tileHTML = (id, name, bg) => `<li class="board-tile" id="${id}" data-board="${id}" data-bg="${bg}" itemscope itemtype="urn:board:BoardRef">
  <a href="/boards/${id}.html" itemprop="name">${esc(name)}</a>
  ${metaHTML('starred', false)}
  ${metaHTML('bg', bg)}
  <button class="tile-archive" type="button" aria-label="Archive board">Archive</button>
  <button class="star" type="button" aria-pressed="false" aria-label="Star board">&#9733;</button>
</li>`;

/* The board document. One document per board, as specified. */
const boardDoc = (id, name, bg) => `<!DOCTYPE html>
<html lang="en" xmlns:pagelove="https://pagelove.org/1.0">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Board</title>
<link rel="icon" type="image/svg+xml" href="/img/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body class="board" data-bg="${bg}" data-board="${id}" itemscope itemtype="urn:board:Board">
<meta data-f="board-bg" content="${bg}">
<div id="whoami-server" hidden pagelove:template="text/liquid">{{ request.auth.username }}|{{ request.auth.claims.name }}|{{ request.auth.claims.email }}|{{ request.auth.claims.picture }}|{% for r in request.auth.role %}{{ r }} {% endfor %}</div>
<header class="topbar">
  <a class="home-link" href="/">Board</a>
  <h1 class="board-name" contenteditable="plaintext-only" data-f="board-name" itemprop="name">${esc(name)}</h1>
  <div class="spacer"></div>
  <div class="avatars" id="avatars"></div>
</header>

<div class="board-canvas">
  <main class="lists-row" id="lists"></main>
  <div class="add-list" id="add-list">
    <button type="button" id="add-list-toggle">+ Add another list</button>
    <form id="add-list-form" hidden>
      <input name="name" placeholder="Enter list title…" autocomplete="off">
      <div class="quick-add-row" style="margin-top:6px">
        <button class="btn-primary" type="submit">Add list</button>
        <button class="icon-btn" type="button" data-cancel>&times;</button>
      </div>
    </form>
  </div>
</div>

<div hidden id="archive" itemprop="archive"></div>
<div hidden id="presence"></div>
<div hidden id="goals"></div>
<div hidden id="goals-archive"></div>
<meta data-f="digest" content="">
<meta data-f="digest-sent" content="">
<div hidden id="labels">
  <meta data-label="green" content=""><meta data-label="yellow" content="">
  <meta data-label="orange" content=""><meta data-label="red" content="">
  <meta data-label="purple" content=""><meta data-label="blue" content="">
  <meta data-label="black" content=""><meta data-label="plum" content="">
</div>
<div hidden id="members"></div>
<div hidden id="activity"></div>

<script src="/app.js"></script>
</body>
</html>`;

/* ============================ BOARD ============================ */
const listHTML = (id, name) => `<section class="list" id="${id}" itemscope itemtype="urn:board:List" draggable="true">
  <div class="list-head">
    <h2 class="list-title" data-f="list-name" itemprop="name">${esc(name)}</h2>
    <button class="icon-btn list-menu" type="button" data-act="rename-list" title="Rename list">&#9998;</button>
    <button class="icon-btn list-menu" type="button" data-act="collapse" title="Collapse list">&#8722;</button>
    <button class="icon-btn list-menu" type="button" data-act="move-all" title="Move all cards">&#8677;</button>
    <button class="icon-btn list-menu" type="button" data-act="archive-list" title="Archive list">&#215;</button>
  </div>
  <div class="cards" id="${id}-cards"></div>
  <button class="add-toggle" type="button" data-act="add-card">+ Add a card</button>
  <form class="quick-add" hidden>
    <textarea name="title" placeholder="Enter a title for this card…"></textarea>
    <div class="quick-add-row">
      <button class="btn-primary" type="submit">Add card</button>
      <button class="icon-btn" type="button" data-cancel>&times;</button>
    </div>
  </form>
</section>`;

const cardHTML = (id, title) => `<article class="card" id="${id}" itemscope itemtype="urn:board:Card" draggable="true">
  <div class="card-title" data-f="card-title" itemprop="name">${esc(title)}</div>
  <meta data-f="card-home" content="">
  <meta data-f="card-labels" content="">
  <meta data-f="card-members" content="">
  <meta data-f="card-due" content="">
  <meta data-f="card-done" content="">
  <meta data-f="card-epic" content="">
  <div class="card-desc" data-f="card-desc" hidden></div>
</article>`;

/* ---------------------------------------------------------------
   Card fields.

   Every field is its own element inside the card, so a label toggle or a due
   date is a one-element write and can't clobber someone else's edit to a
   different field of the same card. Set-valued fields (labels, members) are
   space-separated id lists — last-write-wins per the brief.
   --------------------------------------------------------------- */
/* The eight Trello colours the import mapped onto. They are only defaults now:
   a board's labels live in its own #labels element, colour included, so a board
   can have as many as it likes. Boards written before colours were data have
   metas with no data-hex, and fall back to these by id. */
const DEFAULT_LABELS = [
  { id: 'green',  hex: '#61bd4f' }, { id: 'yellow', hex: '#f2d600' },
  { id: 'orange', hex: '#ff9f1a' }, { id: 'red',    hex: '#eb5a46' },
  { id: 'purple', hex: '#c377e0' }, { id: 'blue',   hex: '#0079bf' },
  { id: 'black',  hex: '#344563' }, { id: 'plum',   hex: '#6c547b' },
];
const FALLBACK_HEX = '#8993a4';
function labels() {
  const els = [...document.querySelectorAll('#labels [data-label]')];
  if (!els.length) return DEFAULT_LABELS.slice();
  return els.map(el => {
    const id = el.getAttribute('data-label');
    return { id, hex: el.getAttribute('data-hex') ||
             DEFAULT_LABELS.find(d => d.id === id)?.hex || FALLBACK_HEX };
  });
}
const labelDef = id => labels().find(l => l.id === id);

const fieldOf = (card, f) => card.querySelector('[data-f="' + f + '"]');
const readField = (card, f) => {
  const el = fieldOf(card, f);
  if (!el) return '';
  return el.tagName === 'META' ? (el.getAttribute('content') || '') : el.textContent;
};
const readSet = (card, f) => readField(card, f).split(/\s+/).filter(Boolean);

/* Mirror locally first, then write. Selector writes cost ~1s on a big
   document on this platform, so the UI must never sit behind one — callers
   paint from the mirrored state immediately and handle the promise. */
function writeField(path, card, f, value) {
  const el = fieldOf(card, f);
  if (el) el.setAttribute('content', value);
  else card.insertAdjacentHTML('beforeend', metaHTML(f, value));
  return setField(path, '#' + card.id, f, value);
}

function toggleInSet(path, card, f, id) {
  const set = new Set(readSet(card, f));
  set.has(id) ? set.delete(id) : set.add(id);
  const p = writeField(path, card, f, [...set].join(' '));
  renderCardFront(card);
  return p;
}

/* Due-date states drive the colour, and are recomputed on render rather than
   stored, so a card that quietly becomes overdue shows it without a write. */
/* Lists people actually treat as "finished". A heuristic on the name, since
   nothing marks a list as terminal — 'Doing' deliberately does not match. */
const DONE_LIST = /\bdone\b|shipped|complete|closed/i;
const inDoneList = card => DONE_LIST.test(card.closest('.list')?.querySelector('.list-title')?.textContent || '');

/* A bare YYYY-MM-DD means that calendar day wherever you are. new Date() would
   read it as UTC midnight, which is the evening before for anyone west of
   Greenwich — a due date of the 15th showing as the 14th. */
const parseDue = v => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00' : v);

function dueState(card) {
  const due = readField(card, 'card-due');
  if (!due) return null;
  /* The tick is one way to finish something; dragging it to Done is the way
     people actually use. Either counts, so a finished card stops nagging. */
  if (readField(card, 'card-done') === 'true' || inDoneList(card)) return 'complete';
  const ms = parseDue(due).getTime() - Date.now();
  if (ms < 0) return 'overdue';
  if (ms < 24 * 3600e3) return 'soon';
  return 'upcoming';
}

const DUE_TEXT = { complete: 'Complete', overdue: 'Overdue', soon: 'Due soon', upcoming: 'Due' };

function fmtDue(v) {
  const d = parseDue(v);
  const opts = { day: 'numeric', month: 'short' };
  if (v.includes('T') && !v.endsWith('T00:00')) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return d.toLocaleString(undefined, opts);
}

/* The face of a card: label bar, due pill, member avatars. Rebuilt from the
   card's own fields, so it is correct after a local edit or a remote one. */
function renderCardFront(card) {
  /* Covers are shelved for now; labels render at the top instead. Any strip
     drawn by an older build is cleaned off. */
  card.querySelector('.card-cover')?.remove();

  let topBar = card.querySelector('.label-bar-top');
  const labelSet = readSet(card, 'card-labels');
  if (labelSet.length) {
    if (!topBar) {
      topBar = document.createElement('div');
      topBar.className = 'label-bar-top';
      card.prepend(topBar);
    }
    topBar.innerHTML = labelSet.map(l => {
      const def = labelDef(l);
      return def ? `<span class="chip" data-label="${l}" style="background:${def.hex}">${esc(labelName(l))}</span>` : '';
    }).join('');
  } else if (topBar) topBar.remove();

    let badges = card.querySelector('.card-badges');
  if (!badges) {
    badges = document.createElement('div');
    badges.className = 'card-badges';
    card.appendChild(badges);
  }
  const members = readSet(card, 'card-members');
  const state = dueState(card);
  const due = readField(card, 'card-due');

  const duePill = state
    ? `<span class="due-pill" data-state="${state}" title="${DUE_TEXT[state]}">${state === 'complete' ? '&#10003; ' : ''}${esc(fmtDue(due))}</span>` : '';

  const avatars = members.map(sub =>
    avatarHTML(sub, memberName(sub), 'avatar avatar-sm')).join('');

  const ep = epicOf(card);
  const epicBadge = ep ? `<span class="epic-badge" title="Epic: ${esc(epicName(ep))}">&#9670; ${esc(epicName(ep))}</span>` : '';
  badges.innerHTML = duePill || avatars || epicBadge
    ? `<div class="badge-row">${epicBadge}${duePill}${avatars}</div>` : '';
  card.classList.toggle('has-labels', labelSet.length > 0);
}

/* Epics live on the board, off the columns: a registry like #labels, but each
   epic is an article of fields so name, target date and description are
   separate one-element writes. A task points at its epic through card-epic;
   a pointer to an epic that no longer exists reads as no epic at all. */
const epics = () => [...document.querySelectorAll('#epics .epic')];
const epicName = ep => readField(ep, 'epic-name') || 'Untitled epic';
function epicOf(card) {
  const id = readField(card, 'card-epic');
  const ep = id && document.getElementById(id);
  return ep && ep.classList.contains('epic') ? ep : null;
}
const isDone = card => readField(card, 'card-done') === 'true' || inDoneList(card);
const epicTasks = ep => [...document.querySelectorAll('#lists .card')].filter(c => readField(c, 'card-epic') === ep.id);
function epicProgress(ep) {
  const t = epicTasks(ep), done = t.filter(isDone).length;
  return { total: t.length, done, pct: t.length ? Math.round(100 * done / t.length) : 0 };
}
const epicHTML = (id, name, due, desc) => `<article class="epic" id="${id}">` +
  metaHTML('epic-name', name) + metaHTML('epic-due', due || '') +
  `<div class="epic-desc" data-f="epic-desc" hidden>${esc(desc || '')}</div></article>`;
async function createEpic(path, name, due, desc) {
  const id = uid('E');
  const html = epicHTML(id, name, due, desc);
  let box = document.getElementById('epics');
  if (!box) {
    document.body.insertAdjacentHTML('beforeend', '<div hidden id="epics"></div>');
    box = document.getElementById('epics');
    await PL.post(path, 'body', '<div hidden id="epics"></div>', 'append');
  }
  box.insertAdjacentHTML('beforeend', html);
  try { await postEventually(path, '#epics', html, 'append'); }
  catch (err) { document.getElementById(id)?.remove(); throw err; }
  return id;
}

/* Label names and board members live on the board, not the card. */
function labelName(id) {
  const el = document.querySelector('#labels [data-label="' + id + '"]');
  return el ? el.getAttribute('content') || '' : '';
}
function memberName(sub) {
  const el = document.querySelector('#members [data-sub="' + sub + '"]');
  return el ? el.getAttribute('data-name') || sub : sub;
}
function boardMembers() {
  return [...document.querySelectorAll('#members [data-sub]')].map(el => ({
    sub: el.getAttribute('data-sub'), name: el.getAttribute('data-name') || el.getAttribute('data-sub'),
  }));
}

/* ---------------------------------------------------------------
   Activity.

   Append-only, always. An entry is never rewritten or deleted, so the feed is
   a record of what happened rather than a view of current state. POST is the
   right primitive for it: concurrent appends to the same element both land on
   this platform, so two people acting at once can't lose each other's entry.
   --------------------------------------------------------------- */
function actHTML(id, cardId, who, sub, text) {
  return `<article class="act" id="${id}" data-card="${esc(cardId || '')}">` +
    `<meta data-f="act-at" content="${new Date().toISOString()}">` +
    `<meta data-f="act-who" content="${esc(who)}">` +
    `<meta data-f="act-sub" content="${esc(sub)}">` +
    `<span data-f="act-text">${esc(text)}</span></article>`;
}

/* Activity must never block or undo the thing it is describing, so a failed
   append is swallowed rather than surfaced. */
async function logAct(path, cardId, text) {
  const me = whoami();
  if (!me) return;
  const html = actHTML(uid('A'), cardId, me.name, me.sub, me.name + ' ' + text);
  try {
    if (!document.getElementById('activity')) {
      document.body.insertAdjacentHTML('beforeend', '<div hidden id="activity"></div>');
      try { await PL.post(path, 'body', '<div hidden id="activity"></div>', 'append'); } catch (_) {}
    }
    await PL.post(path, '#activity', html, 'append');
    const box = document.getElementById('activity');
    if (box) box.insertAdjacentHTML('beforeend', html);
    renderActivity();
    if (box && box.querySelectorAll('.act').length > ACTIVITY_KEEP + 10) trimActivity(path);
  } catch (_) {}
}

const ACTIVITY_KEEP = 60;

/* The activity log lives inside the board document, and every write
   reprocesses the whole document server-side — so an unbounded log makes
   every interaction slower forever. Keep only the most recent entries; the
   rest are deleted (oldest first). Runs on load and after each append. */
async function trimActivity(path) {
  const box = document.getElementById('activity');
  if (!box) return;
  const extra = [...box.querySelectorAll('.act')]
    .sort((a, b) => (readF(a, 'act-at') || '').localeCompare(readF(b, 'act-at') || ''))
    .slice(0, -ACTIVITY_KEEP);
  for (const el of extra) {
    el.remove();
    try { await PL.del(path, '#' + el.id); } catch (_) {}
  }
}

const timeAgo = iso => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

function activityEntries(cardId) {
  const box = document.getElementById('activity');
  if (!box) return [];
  return [...box.querySelectorAll('.act')]
    .filter(a => !cardId || a.dataset.card === cardId)
    .sort((a, b) => (readF(b, 'act-at') || '').localeCompare(readF(a, 'act-at') || ''));
}

const readF = (el, f) => {
  const x = el.querySelector('[data-f="' + f + '"]');
  return x ? (x.tagName === 'META' ? x.getAttribute('content') : x.textContent) : '';
};

function renderActivity() {
  const panel = document.querySelector('#activity-panel .act-list');
  if (!panel) return;
  const rows = activityEntries(null).slice(0, 60);
  panel.innerHTML = rows.length
    ? rows.map(a => `<li>${avatarHTML(readF(a, 'act-sub'), readF(a, 'act-who'), 'avatar avatar-sm')}
        <span><span class="act-text">${esc(readF(a, 'act-text'))}</span><span class="act-when">${esc(timeAgo(readF(a, 'act-at')))}</span></span></li>`).join('')
    : '<li class="empty">Nothing has happened yet.</li>';
}

/* ---------------------------------------------------------------
   Weekly goals.

   Up to five goals pinned above the columns, each a snippet with a 0-100%
   progress bar; the full text lives in the tooltip. Every goal is its own
   element and text and progress are separate fields, so two people updating
   different goals — or the text and the bar of the same goal — never touch
   the same element. Text stays last-write-wins on blur.
   --------------------------------------------------------------- */
const GOAL_LIMIT = 5;   /* per owner: the team, or one person */

/* A goal with no owner is the team's; an owned goal belongs to one person and
   wears their avatar. Existing goals have no owner field and read as team. */
const goalHTML = (id, text, pct, owner) => `<div class="goal" id="${id}">
  <meta data-f="goal-pct" content="${pct}">
  <meta data-f="goal-owner" content="${esc(owner || '')}">
  <meta data-f="goal-done-at" content="">
  <span data-f="goal-text">${esc(text)}</span>
</div>`;

function initGoals(path) {
  document.querySelector('.topbar').insertAdjacentHTML('afterend',
    '<div class="goals-bar"><span class="goals-label">This week</span>' +
    '<div class="goal-chips"></div>' +
    '<div class="goal-adds">' +
      '<button class="goal-add" type="button" data-owner="" title="Add a team goal">+ Team</button>' +
      '<button class="goal-add" type="button" data-owner="me" title="Add a goal of your own">+ Mine</button>' +
    '</div></div>');
  const chips = document.querySelector('.goal-chips');
  const container = () => document.getElementById('goals');
  const me = whoami();

  async function ensureGoals() {
    if (container()) return;
    document.body.insertAdjacentHTML('beforeend', '<div hidden id="goals"></div>');
    try { await PL.post(path, 'body', '<div hidden id="goals"></div>', 'append'); } catch (_) {}
  }

  /* The goals used to be one free-text field; an old board's text becomes its
     first team goal so nothing anyone wrote is lost. */
  async function migrate() {
    const old = document.querySelector('body > [data-f="board-goals"]');
    if (!old || !old.textContent.trim() || container()) return;
    await ensureGoals();
    const html = goalHTML(uid('G'), old.textContent.trim(), 0, '');
    container().insertAdjacentHTML('beforeend', html);
    try { await postEventually(path, '#goals', html, 'append'); } catch (_) {}
  }

  const chipHTML = g => {
    const text = readF(g, 'goal-text');
    const pct = Math.max(0, Math.min(100, +readF(g, 'goal-pct') || 0));
    const owner = readF(g, 'goal-owner');
    const done = pct >= 100;
    return `<div class="goal-chip${owner ? ' goal-mine' : ''}${done ? ' goal-done' : ''}" data-g="${g.id}">
      <div class="goal-chip-top">
        ${owner ? avatarHTML(owner, memberName(owner), 'avatar avatar-xs') : ''}
        ${done ? '<span class="goal-tick">&#10003;</span>' : ''}
        <button class="goal-text" type="button" title="${esc(text)} \u2014 ${done ? 'done' : pct + '%'}">${esc(text)}</button>
      </div>
      <input class="goal-pct" type="range" min="0" max="100" step="5" value="${pct}" style="--pct:${pct}%" aria-label="Progress">
    </div>`;
  };

  function paint() {
    if (chips.querySelector('.goal-edit-input')) return;   /* never repaint under an editor */
    const all = container() ? [...container().querySelectorAll('.goal')] : [];
    const team = all.filter(g => !readF(g, 'goal-owner')).slice(0, GOAL_LIMIT);
    const mine = all.filter(g => readF(g, 'goal-owner') === me.sub).slice(0, GOAL_LIMIT);
    const others = {};
    for (const g of all) {
      const o = readF(g, 'goal-owner');
      if (o && o !== me.sub) (others[o] = others[o] || []).push(g);
    }
    /* Team first, then yours, then everyone else's. */
    chips.innerHTML =
      team.map(chipHTML).join('') +
      mine.map(chipHTML).join('') +
      Object.values(others).map(gs => gs.slice(0, GOAL_LIMIT).map(chipHTML).join('')).join('');
    document.querySelector('.goal-add[data-owner=""]').hidden = team.length >= GOAL_LIMIT;
    document.querySelector('.goal-add[data-owner="me"]').hidden = mine.length >= GOAL_LIMIT;
  }

  function editor(chipEl, g, owner) {
    const inp = document.createElement('input');
    inp.className = 'goal-edit-input';
    inp.value = g ? readF(g, 'goal-text') : '';
    inp.placeholder = owner ? 'My goal\u2026' : 'Team goal\u2026';
    chipEl.replaceChildren(inp);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const v = inp.value.trim();
      const fail = err => { toast('Could not save goal: ' + err.message); boardCtx.resync?.(); };
      /* paint() refuses to run under an open editor, so the editor has to
         leave the DOM before the repaint — not after. */
      inp.remove();
      if (g && !v) {
        g.remove();
        PL.del(path, '#' + g.id).then(() => logAct(path, '', 'removed a weekly goal')).catch(fail);
      } else if (g && v !== readF(g, 'goal-text')) {
        g.querySelector('[data-f="goal-text"]').textContent = v;
        PL.put(path, '#' + g.id + ' [data-f="goal-text"]', `<span data-f="goal-text">${esc(v)}</span>`)
          .then(() => logAct(path, '', 'edited a weekly goal')).catch(fail);
      } else if (!g && v) {
        const html = goalHTML(uid('G'), v, 0, owner);
        ensureGoals().then(() => {
          container().insertAdjacentHTML('beforeend', html);
          paint();
          return postEventually(path, '#goals', html, 'append');
        }).then(() => logAct(path, '', (owner ? 'added a personal goal ' : 'added the team goal ') + v)).catch(fail);
      }
      paint();
    };
    inp.addEventListener('keydown', e => {
      /* Commit directly rather than via blur() — blur is a no-op on an
         element that never actually held focus, and commit() is idempotent. */
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; inp.remove(); paint(); }
    });
    inp.addEventListener('blur', commit);
  }

  document.querySelector('.goal-adds').addEventListener('click', e => {
    const b = e.target.closest('.goal-add');
    if (!b || chips.querySelector('.goal-edit-input')) return;
    chips.insertAdjacentHTML('beforeend', '<div class="goal-chip goal-editing"></div>');
    editor(chips.lastElementChild, null, b.dataset.owner === 'me' ? me.sub : '');
  });

  chips.addEventListener('click', e => {
    const btn = e.target.closest('.goal-text');
    if (!btn) return;
    const chip = btn.closest('.goal-chip');
    const g = document.getElementById(chip.dataset.g);
    editor(chip, g, readF(g, 'goal-owner'));
  });

  /* Dragging the bar previews the fill; the write happens on release. */
  chips.addEventListener('input', e => {
    const inp = e.target.closest('.goal-pct');
    if (inp) inp.style.setProperty('--pct', inp.value + '%');
  });
  chips.addEventListener('change', e => {
    const inp = e.target.closest('.goal-pct');
    if (!inp) return;
    const g = document.getElementById(inp.closest('.goal-chip').dataset.g);
    const f = g.querySelector('[data-f="goal-pct"]');
    if (f) f.setAttribute('content', inp.value); else g.insertAdjacentHTML('beforeend', metaHTML('goal-pct', inp.value));
    const nowDone = +inp.value >= 100, hadStamp = !!readF(g, 'goal-done-at');
    if (nowDone !== hadStamp) {
      const stamp = nowDone ? new Date().toISOString() : '';
      const df = g.querySelector('[data-f="goal-done-at"]');
      if (df) df.setAttribute('content', stamp); else g.insertAdjacentHTML('beforeend', metaHTML('goal-done-at', stamp));
      setField(path, '#' + g.id, 'goal-done-at', stamp).catch(() => {});
    }
    paint();
    setField(path, '#' + g.id, 'goal-pct', inp.value)
      .then(() => { if (+inp.value >= 100) logAct(path, '', 'completed the goal ' + readF(g, 'goal-text')); })
      .catch(err => { toast('Could not save progress: ' + err.message); boardCtx.resync?.(); });
  });

  /* Completed goals disappear over the weekend. There is no scheduler on
     this platform, so whoever opens the board first after Saturday performs
     the clearing: any goal that reached 100% before the most recent Saturday
     midnight is deleted (with an activity entry). Two people sweeping at
     once just means the second DELETE finds nothing — harmless. */
  function lastSaturday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return d.getTime();
  }

  async function sweep() {
    if (!container()) return;
    const cutoff = lastSaturday();
    for (const g of [...container().querySelectorAll('.goal')]) {
      if ((+readF(g, 'goal-pct') || 0) < 100) continue;
      const at = readF(g, 'goal-done-at');
      if (!at) {
        /* Completed before completion times existed — stamp it now so it
           gets a full week rather than vanishing on sight. */
        const now = new Date().toISOString();
        const f = g.querySelector('[data-f="goal-done-at"]');
        if (f) f.setAttribute('content', now); else g.insertAdjacentHTML('beforeend', metaHTML('goal-done-at', now));
        setField(path, '#' + g.id, 'goal-done-at', now).catch(() => {});
        continue;
      }
      if (new Date(at).getTime() < cutoff) {
        /* Completed goals used to be deleted here; now they move into a
           hidden archive so past weeks stay browsable from the menu. */
        const text = readF(g, 'goal-text');
        if (!document.getElementById('goals-archive')) {
          document.body.insertAdjacentHTML('beforeend', '<div hidden id="goals-archive"></div>');
          try { await PL.post(path, 'body', '<div hidden id="goals-archive"></div>', 'append'); } catch (_) {}
        }
        document.getElementById('goals-archive').appendChild(g);
        try {
          await moveVerified(path, g.id, '#goals-archive', 'append', '#goals-archive');
          logAct(path, '', 'archived the completed goal ' + text);
        } catch (_) { /* the next sweep retries */ }
      }
    }
  }

  migrate().then(() => { sweep(); paint(); });
  boardCtx.paintGoals = paint;
}

/* ---------------------------------------------------------------
   Daily Slack digest.

   Pagelove has no scheduler, so the first person to open an opted-in board
   after DIGEST_HOUR sends the summary and stamps the date on the board;
   everyone after that finds it already stamped. If nobody opens the board
   that day, nothing is sent — agreed as acceptable.

   The browser posts to Slack directly: incoming webhooks answer
   access-control-allow-origin:* and accept a text/plain body, so no
   preflight and no server-side relay are needed. The webhook lives in
   /admin/slack.html rather than in this file, so it is not in the bundle
   every board load fetches — and both are readable only by signed-in
   members, which is the same audience as the boards.
   --------------------------------------------------------------- */
const DIGEST_HOUR = 8;

const todayStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* A summary of where things stand, not a replay of every event: what is
   due, what is late, how the goals are going, and a capped tail of what
   changed. Reads the board that is already in the DOM. */
/* Slack mentions are opt-in per person: a member with a Slack ID recorded in
   /admin/slack.html gets tagged, everyone else stays plain text. Mentions are
   applied only inside the People group — the section about assignments — so a
   card that merely has someone's name in its title never pings them. */
function mentionise(text, slackIds) {
  /* Only the part naming people gets mentions — everything from the last
     " on " / " to " / " from " onward is the card title, and titles like
     "alice payroll form" or "bob contract" would otherwise ping someone every
     time anyone was assigned to them. */
  const sep = /\s(?:on|to|from)\s/g;
  let cut = text.length, m;
  while ((m = sep.exec(text)) !== null) cut = m.index;
  let head = text.slice(0, cut), tail = text.slice(cut);

  /* Longest names first: "Sam" sits inside "Samantha", and replacing the
     short one first would leave "<@U…>antha". */
  const pairs = Object.entries(slackIds)
    .map(([sub, id]) => [memberName(sub), id])
    .filter(([name]) => name && !/^\d+$/.test(name))
    .sort((x, y) => y[0].length - x[0].length);

  for (const [name, id] of pairs) {
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    if (head.includes('<@' + id + '>')) continue;
    head = head.replace(re, '<@' + id + '>');
  }
  return head + tail;
}

function buildDigest(slackIds = {}) {
  const boardName = document.querySelector('[data-f="board-name"]')?.textContent.trim() || 'Board';
  const day = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const out = [`*${boardName}* \u2014 ${day}`];

  const cards = [...document.querySelectorAll('#lists .card')];
  const nameOf = c => readField(c, 'card-title');
  const listOf = c => c.closest('.list')?.querySelector('.list-title')?.textContent.trim() || '';
  const who = c => readSet(c, 'card-members').map(s => memberName(s)).join(', ');

  const goals = [...document.querySelectorAll('#goals .goal')];
  if (goals.length) {
    out.push('', '*This week*');
    for (const g of goals) {
      const pct = Math.max(0, Math.min(100, +readF(g, 'goal-pct') || 0));
      const owner = readF(g, 'goal-owner');
      const tag = owner ? ` (${memberName(owner)})` : '';
      out.push(pct >= 100 ? `\u2022 ~${readF(g, 'goal-text')}~${tag} \u2713 done`
                          : `\u2022 ${readF(g, 'goal-text')}${tag} \u2014 ${pct}%`);
    }
  }

  const overdue = cards.filter(c => dueState(c) === 'overdue');
  const soon = cards.filter(c => dueState(c) === 'soon');
  if (overdue.length) {
    out.push('', `*Overdue* (${overdue.length})`);
    overdue.slice(0, 8).forEach(c => out.push(`\u2022 ${nameOf(c)} \u2014 ${listOf(c)}${who(c) ? ' \u2014 ' + who(c) : ''}`));
    if (overdue.length > 8) out.push(`\u2026 and ${overdue.length - 8} more`);
  }
  if (soon.length) {
    out.push('', `*Due soon* (${soon.length})`);
    soon.slice(0, 8).forEach(c => out.push(`\u2022 ${nameOf(c)} \u2014 ${listOf(c)}${who(c) ? ' \u2014 ' + who(c) : ''}`));
  }

  /* The activity log is capped, so a very busy day can overflow it — say so
     rather than quietly under-reporting. */
  const since = Date.now() - 24 * 3600e3;
  const recent = activityEntries(null).filter(e => new Date(readF(e, 'act-at')).getTime() > since);

  /* Grouped by what happened rather than a flat stream: finished work first,
     then new work, then everything else. Each entry lands in exactly one
     group, and anything unmatched still shows under Other so nothing is
     silently dropped. */
  const GROUPS = [
    ['Finished',   t => / to [^,]*\b(done|shipped|complete|closed)\b/i.test(t) || /completed the goal/i.test(t)],
    ['Added',      t => /\badded\b|\bconverted\b/i.test(t)],
    ['Moved',      t => /\bmoved\b/i.test(t)],
    ['Archived',   t => /\barchived\b|\brestored\b/i.test(t)],
    ['Discussion', t => /\bcommented\b/i.test(t)],
    ['Goals',      t => /goal/i.test(t)],
    ['People',     t => /\bassigned\b|unassigned/i.test(t)],
  ];
  if (recent.length) {
    out.push('', `*Last 24 hours* (${recent.length} change${recent.length === 1 ? '' : 's'})`);
    const left = recent.map(e => readF(e, 'act-text'));
    for (const [label, match] of GROUPS) {
      const hit = left.filter(match);
      if (!hit.length) continue;
      hit.forEach(t => left.splice(left.indexOf(t), 1));
      out.push('', `*${label}* (${hit.length})`);
      hit.slice(0, 8).forEach(t => out.push(`\u2022 ${label === 'People' ? mentionise(t, slackIds) : t}`));
      if (hit.length > 8) out.push(`\u2026 and ${hit.length - 8} more`);
    }
    if (left.length) {
      out.push('', `*Other* (${left.length})`);
      left.slice(0, 5).forEach(t => out.push(`\u2022 ${t}`));
    }
  } else {
    out.push('', '_No changes in the last 24 hours._');
  }

  out.push('', location.origin + location.pathname);
  return out.join('\n');
}

async function sendDigest(path, { manual = false } = {}) {
  const stampEl = document.querySelector('body > [data-f="digest-sent"]');
  const today = todayStamp();
  if (!manual) {
    if (document.querySelector('body > [data-f="digest"]')?.getAttribute('content') !== 'on') return;
    if (new Date().getHours() < DIGEST_HOUR) return;
    if (stampEl && stampEl.getAttribute('content') === today) return;
    /* Claim the day before sending, so two people opening at once don't both
       post. A failed send releases the claim for the next person. */
    await upsert(path, 'body', 'body > [data-f="digest-sent"]', metaHTML('digest-sent', today));
    if (stampEl) stampEl.setAttribute('content', today);
    else document.body.insertAdjacentHTML('beforeend', metaHTML('digest-sent', today));
  }

  let hook = '', slackIds = {};
  try {
    const r = await fetch('/admin/slack.html?v=' + Date.now(), { cache: 'no-store' });
    const cfg = await r.text();
    hook = cfg.match(/data-f="slack-webhook" content="([^"]+)"/)?.[1] || '';
    for (const m of cfg.matchAll(/data-sub="([^"]+)" data-slack="([^"]+)"/g)) slackIds[m[1]] = m[2];
  } catch (_) {}
  if (!hook) { if (manual) toast('No Slack webhook configured'); return; }

  try {
    /* text/plain keeps this a simple request: no preflight, and Slack
       accepts a JSON body regardless of the declared type. */
    await fetch(hook, { method: 'POST', body: JSON.stringify({ text: buildDigest(slackIds) }) });
    if (manual) toast('Digest sent to Slack');
  } catch (err) {
    if (!manual && stampEl) {
      stampEl.setAttribute('content', '');
      upsert(path, 'body', 'body > [data-f="digest-sent"]', metaHTML('digest-sent', '')).catch(() => {});
    }
    toast('Could not send digest: ' + err.message);
  }
}

/* ---------------------------------------------------------------
   Archive.

   Archiving is a MOVE into the board's #archive container, and restoring is
   the same MOVE in reverse — the card records the list it came from before it
   leaves, so it goes home rather than to wherever happens to be first.
   --------------------------------------------------------------- */
function renderArchive(path) {
  const box = document.querySelector('#activity-panel .archive-list');
  const arch = document.getElementById('archive');
  if (!box) return;
  const items = arch ? [...arch.children].filter(el => el.classList.contains('card') || el.classList.contains('list')) : [];
  box.innerHTML = items.length ? items.map(el => {
    const isList = el.classList.contains('list');
    const name = isList
      ? el.querySelector('.list-title')?.textContent
      : el.querySelector('.card-title')?.textContent;
    const at = !isList && el.querySelector('[data-f="card-archived-at"]')?.getAttribute('content');
    const when = at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    return `<li><span class="arch-kind">${isList ? 'list' : 'card'}</span>
      <span class="arch-name">${esc(name || '(untitled)')}</span>
      ${when ? `<span class="act-when">${esc(when)}</span>` : ''}
      <button class="linkish" type="button" data-restore="${el.id}">Restore</button></li>`;
  }).join('') : '<li class="empty">Nothing archived.</li>';
}

async function restoreArchived(path, id, ctx) {
  const el = document.getElementById(id);
  if (!el) return;
  const isList = el.classList.contains('list');
  const name = (isList ? el.querySelector('.list-title') : el.querySelector('.card-title'))?.textContent || '';

  let destSel, containerSel;
  if (isList) {
    destSel = containerSel = '#lists';
  } else {
    /* Prefer the list the card was archived from; fall back to the first list
       if that one has since been archived or deleted. */
    const home = readField(el, 'card-home');
    const homeEl = home && document.getElementById(home);
    const fallback = document.querySelector('#lists .list .cards');
    if (!homeEl && !fallback) return toast('No list to restore into — add a list first.');
    destSel = containerSel = '#' + (homeEl ? home : fallback.id);
  }

  const target = document.querySelector(containerSel);
  target.appendChild(el);
  try {
    await moveVerified(path, id, destSel, 'append', containerSel);
    if (isList) ctx.wireList(el); else ctx.wireCard(el);
    logAct(path, isList ? '' : id, 'restored ' + name);
    renderArchive(path);
  } catch (err) {
    document.getElementById('archive').appendChild(el);
    renderArchive(path);
    toast('Could not restore: ' + err.message);
  }
}

/* Completed goals from past weeks, newest first, with who they belonged to. */
function renderPastGoals() {
  const box = document.querySelector('#activity-panel .past-goals');
  if (!box) return;
  const arch = document.getElementById('goals-archive');
  const gs = arch ? [...arch.querySelectorAll('.goal')] : [];
  gs.sort((x, y) => (readF(y, 'goal-done-at') || '').localeCompare(readF(x, 'goal-done-at') || ''));
  box.innerHTML = gs.map(g => {
    const owner = readF(g, 'goal-owner');
    const at = readF(g, 'goal-done-at');
    const when = at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    return `<li>${owner ? avatarHTML(owner, memberName(owner), 'avatar avatar-sm') : '<span class="past-team">Team</span>'}
      <span class="past-text">${esc(readF(g, 'goal-text'))}</span><span class="act-when">${esc(when)}</span></li>`;
  }).join('') || '<li class="empty">Nothing completed yet \u2014 this fills up as weekly goals hit 100%.</li>';
}

/* The background is stored as a field so it can be written on its own; the
   attribute the stylesheet keys off is set from it here. */
function applyBoardBg() {
  const f = document.querySelector('body > [data-f="board-bg"]');
  const v = f && f.getAttribute('content');
  if (v) document.body.dataset.bg = v;
}

/* ---------------------------------------------------------------
   Markdown.

   Deliberately small, and it escapes before it formats. Descriptions are
   stored as raw text in a shared document that everyone on the team can
   write to, so rendered HTML is never persisted and never trusted — the
   stored value is always the markdown source.
   --------------------------------------------------------------- */
function md(src) {
  const lines = esc(src).split('\n');
  let out = '', list = null;
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>')
    /* Images before links: the link rule would otherwise match the [alt](url)
       half of ![alt](url) and leave a stray "!". Only our own /uploads/ and
       http(s) are allowed through, so a pasted javascript: URL stays text. */
    .replace(/!\[([^\]]*)\]\((\/uploads\/[^\s)]+|https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" rel="noopener noreferrer" target="_blank"><img src="$2" alt="$1" loading="lazy"></a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');

  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList(); out += `<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; }
      out += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; }
      out += `<li>${inline(m[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList(); out += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return out;
}

/* ---------------------------------------------------------------
   Checklists and comments.

   Both hang off the card and both grow by POST, which accumulates under
   concurrency here — two people adding comments at the same moment both land.
   Ticking an item is a one-field write, last-write-wins, per the brief.
   --------------------------------------------------------------- */
const checklistHTML = (id, name) => `<section class="checklist" id="${id}">
  <meta data-f="checklist-name" content="${esc(name)}">
  <div class="check-items" id="${id}-items"></div>
</section>`;

const checkItemHTML = (id, text) => `<div class="check-item" id="${id}">
  <meta data-f="item-done" content="">
  <span data-f="item-text">${esc(text)}</span>
</div>`;

const commentHTML = (id, sub, name, body) => `<article class="comment" id="${id}" data-sub="${esc(sub)}">
  <meta data-f="comment-who" content="${esc(name)}">
  <meta data-f="comment-at" content="${new Date().toISOString()}">
  <div data-f="comment-body">${esc(body)}</div>
</article>`;

/* Cards predate these containers, so they are created on demand. */
async function ensureCardContainers(path, card) {
  for (const [cls, id] of [['checklists', card.id + '-checklists'], ['comments', card.id + '-comments'], ['attachments', card.id + '-attachments']]) {
    if (!card.querySelector('#' + CSS.escape(id))) {
      const html = `<div class="${cls}" id="${id}"></div>`;
      card.insertAdjacentHTML('beforeend', html);
      try { await PL.post(path, '#' + card.id, html, 'append'); } catch (_) {}
    }
  }
}

const attachmentHTML = (id, url, name, kind) => `<div class="attachment" id="${id}">
  <meta data-f="att-url" content="${esc(url)}">
  <meta data-f="att-name" content="${esc(name)}">
  <meta data-f="att-kind" content="${kind}">
</div>`;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i;

/* Blobs live under /uploads/, named by card + time so they never collide.
   Verified up to 8 MB on this host. */
async function uploadBlob(cardId, file, fallbackName) {
  const safe = (file.name || fallbackName).replace(/[^\w.-]+/g, '_');
  const url = '/uploads/' + cardId + '-' + Date.now().toString(36) + '-' + safe;
  const up = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!up.ok) throw new Error('upload \u2192 ' + up.status);
  return url;
}
const imagesIn = dt => [...(dt?.files || [])].filter(f => f.type.startsWith('image/'));

/* A write into an element that was itself just written can outrun the
   server's read path — the selector 416s for a moment even though the
   container is there. Confirmed intermittent on this host, same family as
   the MOVE loss. Retrying until the document catches up converges. */
async function postEventually(path, sel, html, placement) {
  /* Nine tries over ~8s: the staleness window has been observed to outlast a
     short budget, and giving up surfaces as a user-visible failure for a
     write that would have landed moments later. */
  for (let i = 0; ; i++) {
    try { return await PL.post(path, sel, html, placement); }
    catch (err) {
      if (!/\u2192 416$/.test(err.message) || i >= 8) throw err;
      await new Promise(r => setTimeout(r, 300 + i * 200));
    }
  }
}

function addAttachment(path, card, url, name, kind) {
  const html = attachmentHTML(uid('AT'), url, name, kind);
  card.querySelector('#' + CSS.escape(card.id + '-attachments')).insertAdjacentHTML('beforeend', html);
  return postEventually(path, '#' + card.id + '-attachments', html, 'append');
}

/* ---------------------------------------------------------------
   Card modal.

   The open card is part of the URL, so a card link pasted into Slack opens
   that card for whoever follows it, and Back closes the modal rather than
   leaving the board.
   --------------------------------------------------------------- */
const MODAL_HTML = `<dialog id="card-modal" tabindex="-1">
  <div class="modal-bar">
    <button class="modal-list-chip" type="button" title="Move to another list"></button>
    <div class="spacer"></div>
    <button class="icon-btn" type="button" data-act="close" aria-label="Close">&times;</button>
  </div>
  <div class="list-pop" hidden></div>

  <div class="modal-cols">
  <div class="modal-main">
    <div class="modal-head">
      <button class="done-circle" type="button" title="Mark complete" aria-pressed="false"></button>
      <h2 class="modal-title" contenteditable="plaintext-only"></h2>
    </div>

    <div class="modal-adds">
      <button class="add-chip" type="button" data-open="labels">Labels</button>
      <button class="add-chip" type="button" data-open="due">Dates</button>
      <button class="add-chip" type="button" data-open="checklists">Checklist</button>
      <button class="add-chip" type="button" data-open="members">Members</button>
      <button class="add-chip" type="button" data-open="epic">Epic</button>
      <button class="add-chip" type="button" data-open="attachments">Attachment</button>
    </div>

    <section class="modal-section" data-sec="labels">
      <h3>Labels</h3>
      <div class="labels-applied"></div>
      <div class="label-pop" hidden><div class="label-picker"></div></div>
    </section>

    <section class="modal-section" data-sec="members">
      <h3>Members</h3>
      <div class="members-applied"></div>
      <div class="member-pop" hidden><div class="member-picker"></div></div>
    </section>

    <section class="modal-section" data-sec="epic">
      <h3>Epic</h3>
      <div class="epic-applied"></div>
      <div class="epic-pop" hidden><div class="epic-picker"></div></div>
    </section>

    <section class="modal-section" data-sec="due">
      <h3>Dates</h3>
      <div class="due-row">
        <input type="date" class="due-date">
        <input type="time" class="due-time">
        <label class="due-done"><input type="checkbox"> Complete</label>
        <button class="btn-ghost" type="button" data-act="clear-due">Clear</button>
      </div>
    </section>

    <section class="modal-section" data-sec="desc">
      <div class="sec-head"><h3>Description</h3><button class="btn-ghost" type="button" data-act="edit-desc">Edit</button></div>
      <div class="desc-view" data-empty="Add a more detailed description\u2026"></div>
      <textarea class="desc-edit" hidden placeholder="Add a more detailed description\u2026"></textarea>
    </section>

    <section class="modal-section" data-sec="attachments">
      <div class="sec-head"><h3>Attachments</h3><button class="btn-ghost" type="button" data-open="attachments">Add</button></div>
      <ul class="attachment-list"></ul>
      <div class="att-row" hidden>
        <label class="btn-ghost att-upload">Upload file<input class="att-file" type="file" hidden></label>
        <form class="add-link"><input name="url" placeholder="Paste a link\u2026" autocomplete="off"><button class="btn-ghost" type="submit">Add link</button></form>
      </div>
    </section>

    <section class="modal-section" data-sec="checklists">
      <h3>Checklists</h3>
      <div class="checklist-list"></div>
      <form class="add-checklist">
        <input name="name" placeholder="Add a checklist\u2026" autocomplete="off">
      </form>
    </section>

    <div class="modal-actions">
      <button class="btn-ghost" type="button" data-act="archive">Archive</button>
      <button class="btn-ghost danger" type="button" data-act="delete">Delete</button>
    </div>
  </div>

  <aside class="modal-rail">
    <h3>Comments and activity</h3>
    <form class="add-comment">
      <textarea name="body" placeholder="Write a comment\u2026"></textarea>
      <button class="btn-primary" type="submit">Comment</button>
    </form>
    <ul class="comment-list"></ul>
    <ul class="act-list card-acts"></ul>
  </aside>
  </div>
</dialog>`;

function renderChecklists(dlg, card) {
  const box = dlg.querySelector('.checklist-list');
  const lists = [...card.querySelectorAll('.checklist')];
  box.innerHTML = lists.map(k => {
    const items = [...k.querySelectorAll('.check-item')];
    const done = items.filter(i => readF(i, 'item-done') === 'true').length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    return `<div class="checklist-block" data-k="${k.id}">
      <div class="checklist-head">
        <strong>${esc(readF(k, 'checklist-name'))}</strong>
        <span class="checklist-count">${done}/${items.length}</span>
        <button class="icon-btn" type="button" data-act="del-checklist" title="Delete checklist">&times;</button>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      ${items.map(i => `<label class="check-row" data-i="${i.id}">
          <input type="checkbox" ${readF(i, 'item-done') === 'true' ? 'checked' : ''}>
          <span class="${readF(i, 'item-done') === 'true' ? 'ticked' : ''}">${esc(readF(i, 'item-text'))}</span>
          <button class="icon-btn" type="button" data-act="to-card" title="Convert to card">&#8599;</button>
        </label>`).join('')}
      <form class="add-item"><input name="text" placeholder="Add an item…" autocomplete="off"></form>
    </div>`;
  }).join('');
}

function renderComments(dlg, card) {
  const me = whoami() || { sub: null };
  const box = dlg.querySelector('.comment-list');
  const rows = [...card.querySelectorAll('.comment')]
    .sort((a, b) => (readF(b, 'comment-at') || '').localeCompare(readF(a, 'comment-at') || ''));
  box.innerHTML = rows.map(c => {
    const mine = c.dataset.sub === me.sub;
    return `<li class="comment-row" data-c="${c.id}">
      ${avatarHTML(c.dataset.sub, readF(c, 'comment-who'), 'avatar avatar-sm')}
      <div class="comment-main">
        <div class="comment-meta"><strong>${esc(readF(c, 'comment-who'))}</strong> <span class="act-when">${esc(timeAgo(readF(c, 'comment-at')))}</span></div>
        <div class="comment-body">${esc(readF(c, 'comment-body'))}</div>
        ${mine ? `<div class="comment-tools">
          <button class="linkish" type="button" data-act="edit-comment">Edit</button>
          <button class="linkish" type="button" data-act="del-comment">Delete</button>
        </div>` : ''}
      </div>
    </li>`;
  }).join('') || '<li class="empty">No comments yet.</li>';
}

function renderAttachments(dlg, card) {
  const rows = [...card.querySelectorAll('.attachment')];
  dlg.querySelector('.attachment-list').innerHTML = rows.map(a => {
    const url = readF(a, 'att-url'), name = readF(a, 'att-name') || url, kind = readF(a, 'att-kind');
    return `<li data-a="${a.id}">
      ${kind === 'image' ? `<img class="att-thumb" src="${esc(url)}" alt="" loading="lazy">` : '<span class="att-icon">&#128206;</span>'}
      <a class="att-name" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>
      <button class="linkish" type="button" data-act="del-att">Remove</button>
    </li>`;
  }).join('') || '<li class="empty">No attachments.</li>';
}

function initCardModal(path, ctx) {
  document.body.insertAdjacentHTML('beforeend', MODAL_HTML);
  const dlg = document.getElementById('card-modal');
  let cardId = null;
  const card = () => (cardId ? document.getElementById(cardId) : null);
  /* Sections exist only when they have content, unless the person opened one
     from the add-row this visit. Cleared every time a card opens. */
  const openedSecs = new Set();

  /* --- open / close, driven by the URL --- */
  function open(id, push) {
    const c = document.getElementById(id);
    if (!c) return;
    cardId = id;
    openedSecs.clear();
    dlg.querySelector('.label-pop').hidden = true;
    dlg.querySelector('.member-pop').hidden = true;
    dlg.querySelector('.list-pop').hidden = true;
    dlg.querySelector('.att-row').hidden = true;
    dlg.querySelector('.epic-pop').hidden = true;
    if (push) history.pushState({ card: id }, '', '?card=' + encodeURIComponent(id));
    fill();
    if (!dlg.open) dlg.showModal();
    /* showModal focuses the first focusable element — the editable title — so
       every keyboard shortcut would type into it instead. Park focus on the
       dialog itself; the title is one Tab away when renaming is the intent. */
    dlg.focus();
  }
  function close(pop) {
    cardId = null;
    if (dlg.open) dlg.close();
    if (!pop) history.pushState({}, '', location.pathname);
  }
  dlg.addEventListener('close', () => { if (cardId) close(false); });
  dlg.querySelector('[data-act="close"]').onclick = () => close(false);
  /* Clicking the board around the card closes it. A backdrop click reports
     the dialog itself as the target with coordinates outside its box;
     clicks on anything inside report the inner element and are ignored. */
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close(false);
  });
  addEventListener('popstate', e => {
    const id = new URLSearchParams(location.search).get('card');
    id ? open(id, false) : close(true);
  });

  /* --- render the modal from the card --- */
  function fill() {
    const c = card();
    if (!c) return;
    const title = dlg.querySelector('.modal-title');
    if (document.activeElement !== title) title.textContent = readField(c, 'card-title');
    const listName = c.closest('.list')?.querySelector('.list-title')?.textContent || 'Archive';
    dlg.querySelector('.modal-list-chip').innerHTML = esc(listName) + ' <span class="chev">&#8964;</span>';
    dlg.querySelector('.done-circle').setAttribute('aria-pressed', readField(c, 'card-done') === 'true' ? 'true' : 'false');

    const on = readSet(c, 'card-labels');
    dlg.querySelector('.labels-applied').innerHTML = on.map(l => {
      const def = labelDef(l);
      return def ? `<span class="chip chip-lg" style="background:${def.hex}">${esc(labelName(l))}</span>` : '';
    }).join('') + '<button class="add-chip plus" type="button" data-open="labels">+</button>';
    dlg.querySelector('.label-picker').innerHTML = labels().map(l => `
      <div class="label-opt">
        <button class="label-swatch" type="button" data-label="${l.id}" aria-pressed="${on.includes(l.id)}"
                style="background:${l.hex}" title="${esc(labelName(l.id))}">${on.includes(l.id) ? '&#10003;' : ''}</button>
        <input class="label-name" data-label="${l.id}" value="${esc(labelName(l.id))}" placeholder="name">
      </div>`).join('') + `
      <form class="label-new">
        <input class="label-new-hex" type="color" value="#4bbf6b" aria-label="Colour for the new label">
        <input class="label-new-name" placeholder="New label\u2026" maxlength="40">
        <button class="btn-ghost" type="submit">Add</button>
      </form>`;

    const ep = epicOf(c);
    dlg.querySelector('.epic-applied').innerHTML = (ep
      ? `<button class="epic-chip" type="button" data-act="open-epic" title="Show in Epics view">&#9670; ${esc(epicName(ep))}</button>` +
        `<button class="icon-btn" type="button" data-act="detach-epic" title="Remove from epic" aria-label="Remove from epic">&times;</button>`
      : '<span class="epic-none">Not part of an epic</span>') +
      '<button class="add-chip plus" type="button" data-open="epic">+</button>';
    dlg.querySelector('.epic-picker').innerHTML = epics().map(e => {
      const p = epicProgress(e);
      return `<button class="epic-opt" type="button" data-epic="${e.id}" aria-pressed="${ep === e}">` +
        `<span class="epic-opt-name">&#9670; ${esc(epicName(e))}</span><span class="epic-opt-meta">${p.done}/${p.total}</span></button>`;
    }).join('') + '<form class="epic-new"><input class="epic-new-name" placeholder="New epic\u2026" maxlength="80">' +
      '<button class="btn-ghost" type="submit">Create</button></form>';

    const mine = readSet(c, 'card-members');
    dlg.querySelector('.members-applied').innerHTML =
      mine.map(s => `<button class="member-remove" type="button" data-sub="${esc(s)}" title="Remove ${esc(memberName(s))}">${avatarHTML(s, memberName(s), 'avatar')}<span class="member-x">&times;</span></button>`).join('') +
      '<button class="add-chip plus" type="button" data-open="members">+</button>';
    dlg.querySelector('.member-picker').innerHTML = boardMembers().map(m => `
      <button class="member-opt" type="button" data-sub="${esc(m.sub)}" aria-pressed="${mine.includes(m.sub)}">
        ${avatarHTML(m.sub, m.name, 'avatar avatar-sm')}
        <span>${esc(m.name)}</span>
      </button>`).join('');

    const due = readField(c, 'card-due');
    dlg.querySelector('.due-date').value = due ? due.slice(0, 10) : '';
    dlg.querySelector('.due-time').value = due && due.includes('T') ? due.slice(11, 16) : '';
    dlg.querySelector('.due-done input').checked = readField(c, 'card-done') === 'true';

    renderAttachments(dlg, c);
    renderChecklists(dlg, c);
    renderComments(dlg, c);
    dlg.querySelector('.card-acts').innerHTML = activityEntries(c.id).slice(0, 30)
      .map(a => `<li>${avatarHTML(readF(a, 'act-sub'), readF(a, 'act-who'), 'avatar avatar-sm')}
        <span><span class="act-text">${esc(readF(a, 'act-text'))}</span><span class="act-when">${esc(timeAgo(readF(a, 'act-at')))}</span></span></li>`).join('')
      || '<li class="empty">No activity on this card yet.</li>';

    /* Trello shows a section only once it says something. */
    const showSec = (name, has) => {
      dlg.querySelector('[data-sec="' + name + '"]').hidden = !has && !openedSecs.has(name);
    };
    showSec('labels', on.length > 0);
    showSec('members', mine.length > 0);
    showSec('epic', !!epicOf(c));
    showSec('due', !!due);
    showSec('attachments', !!c.querySelector('.attachment'));
    showSec('checklists', !!c.querySelector('.checklist'));

    const descEdit = dlg.querySelector('.desc-edit');
    if (descEdit.hidden) {
      const src = readField(c, 'card-desc');
      dlg.querySelector('.desc-view').innerHTML = src ? md(src) : '';
      dlg.querySelector('.desc-view').classList.toggle('is-empty', !src);
    }
  }

  /* --- edits --- */
  editable(dlg.querySelector('.modal-title'), async v => {
    const c = card();
    await PL.put(path, '#' + c.id + ' [data-f="card-title"]',
      `<div class="card-title" data-f="card-title" itemprop="name">${esc(v)}</div>`);
    fieldOf(c, 'card-title').textContent = v;
  });

  dlg.querySelector('.label-picker').addEventListener('click', async e => {
    const b = e.target.closest('.label-swatch');
    if (!b) return;
    const c = card();
    /* Label changes are deliberately not logged: they are low signal, and
       the activity log is capped — logging them evicts things worth reading
       (moves, comments, goals) from both the feed and the daily digest.
       They also cost a second's write each. */
    const p = toggleInSet(path, c, 'card-labels', b.dataset.label);
    fill();
    p.catch(err => { toast('Could not change labels: ' + err.message); boardCtx.resync?.(); });
  });

  /* Label names belong to the board, so renaming one updates every card. The
     whole <meta> is rewritten each time — attributes cannot be written
     independently — so a rename has to carry the colour with it or the colour
     is silently dropped. Colour is chosen once, when the label is created. */
  function writeLabel(id, name, hex) {
    const el = document.querySelector('#labels [data-label="' + id + '"]');
    if (el) { el.setAttribute('content', name); el.setAttribute('data-hex', hex); }
    document.querySelectorAll('#lists .card').forEach(renderCardFront);
    fill();
    boardCtx.refreshLabelFilter();
    return upsert(path, '#labels', '#labels [data-label="' + id + '"]',
      `<meta data-label="${esc(id)}" content="${esc(name)}" data-hex="${esc(hex)}">`)
      .catch(err => { toast('Could not save label: ' + err.message); boardCtx.resync?.(); });
  }

  dlg.querySelector('.label-picker').addEventListener('change', e => {
    const inp = e.target.closest('.label-name');
    if (!inp) return;
    const id = inp.dataset.label;
    writeLabel(id, inp.value, labelDef(id)?.hex || FALLBACK_HEX);
  });

  /* New labels get a generated id, never a colour name: colours are editable,
     so "green" would be a lie the moment someone recoloured it, and ids are
     what every card stores. */
  dlg.querySelector('.label-picker').addEventListener('submit', async e => {
    const form = e.target.closest('.label-new');
    if (!form) return;
    e.preventDefault();
    const name = form.querySelector('.label-new-name').value.trim();
    const hex = form.querySelector('.label-new-hex').value;
    if (!name) return toast('Give the label a name');
    if (labels().some(l => labelName(l.id).toLowerCase() === name.toLowerCase()))
      return toast('There is already a label called ' + name);
    const id = uid('L');
    const meta = `<meta data-label="${id}" content="${esc(name)}" data-hex="${esc(hex)}">`;
    document.getElementById('labels')?.insertAdjacentHTML('beforeend', meta);
    form.reset();
    fill();
    try {
      await postEventually(path, '#labels', meta, 'append');
      boardCtx.refreshLabelFilter();
    } catch (err) {
      document.querySelector('#labels [data-label="' + id + '"]')?.remove();
      fill();
      toast('Could not add label: ' + err.message);
    }
  });

  /* One epic per task. Picking the current one again removes it, as a label
     swatch does; creating a new one attaches it straight away. */
  function setEpic(id) {
    const c = card();
    const p = writeField(path, c, 'card-epic', id);
    renderCardFront(c);
    fill();
    p.catch(err => { toast('Could not change epic: ' + err.message); boardCtx.resync?.(); });
  }
  dlg.querySelector('.epic-picker').addEventListener('click', e => {
    const b = e.target.closest('.epic-opt');
    if (!b) return;
    setEpic(readField(card(), 'card-epic') === b.dataset.epic ? '' : b.dataset.epic);
  });
  dlg.querySelector('.epic-applied').addEventListener('click', e => {
    if (e.target.closest('[data-act="detach-epic"]')) return setEpic('');
    if (e.target.closest('[data-act="open-epic"]')) {
      const id = readField(card(), 'card-epic');
      close(false);
      boardCtx.openEpic(id);
    }
  });
  dlg.querySelector('.epic-picker').addEventListener('submit', async e => {
    const form = e.target.closest('.epic-new');
    if (!form) return;
    e.preventDefault();
    const name = form.querySelector('.epic-new-name').value.trim();
    if (!name) return;
    try {
      const id = await createEpic(path, name);
      logAct(path, '', 'created epic ' + name);
      setEpic(id);
    } catch (err) { toast('Could not create epic: ' + err.message); }
  });

  dlg.querySelector('.members-applied').addEventListener('click', e => {
    const b = e.target.closest('.member-remove');
    if (!b) return;
    const c = card();
    const sub = b.dataset.sub;
    const p = toggleInSet(path, c, 'card-members', sub);
    fill();
    p.then(() => logAct(path, c.id, 'unassigned ' + memberName(sub) + ' on ' + readField(c, 'card-title')))
     .catch(err => { toast('Could not remove member: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.member-picker').addEventListener('click', async e => {
    const b = e.target.closest('.member-opt');
    if (!b) return;
    const c = card();
    const had = readSet(c, 'card-members').includes(b.dataset.sub);
    const p = toggleInSet(path, c, 'card-members', b.dataset.sub);
    fill();
    p.then(() => logAct(path, c.id, (had ? 'unassigned ' : 'assigned ') + memberName(b.dataset.sub) + ' on ' + readField(c, 'card-title')))
     .catch(err => { toast('Could not change members: ' + err.message); boardCtx.resync?.(); });
  });

  const writeDue = () => {
    const c = card();
    const d = dlg.querySelector('.due-date').value;
    const t = dlg.querySelector('.due-time').value;
    const v = d ? (t ? d + 'T' + t : d + 'T00:00') : '';
    const p = writeField(path, c, 'card-due', v);
    renderCardFront(c); fill();
    p.then(() => logAct(path, c.id, (v ? 'set the due date on ' : 'cleared the due date on ') + readField(c, 'card-title')))
     .catch(err => { toast('Could not set due date: ' + err.message); boardCtx.resync?.(); });
  };
  dlg.querySelector('.due-date').onchange = writeDue;
  dlg.querySelector('.due-time').onchange = writeDue;
  dlg.querySelector('[data-act="clear-due"]').onclick = async () => {
    dlg.querySelector('.due-date').value = ''; dlg.querySelector('.due-time').value = '';
    await writeDue();
  };
  dlg.querySelector('.due-done input').onchange = e => {
    const c = card();
    const p = writeField(path, c, 'card-done', e.target.checked ? 'true' : '');
    renderCardFront(c); fill();
    p.catch(err => { toast('Could not update due date: ' + err.message); boardCtx.resync?.(); });
  };

  /* Description is last-write-wins on blur. There is no CRDT and no PATCH on
     this platform, so simultaneous edits to one description cannot merge —
     the later save wins outright. Field-level writes keep the blast radius to
     the description alone. */
  const view = dlg.querySelector('.desc-view');
  const edit = dlg.querySelector('.desc-edit');
  view.onclick = () => {
    edit.value = readField(card(), 'card-desc');
    view.hidden = true; edit.hidden = false; edit.focus();
  };
  edit.addEventListener('keydown', e => {
    if (e.key === 'Escape') { edit.hidden = true; view.hidden = false; fill(); }
  });

  /* Pasting a screenshot into the description. The blob is uploaded like any
     attachment and the description gets a markdown image, so the description
     stays plain text — no rich-text model, and it still greps in search.
     A placeholder holds the spot while the upload runs, so the caret does not
     jump and a slow upload is visible rather than silent. */
  const uploading = [];
  function insertImage(file) {
    const c = card();
    const name = (file.name || 'screenshot.png').replace(/[[\]()]/g, '');
    const token = '![uploading ' + name + '\u2026](#pending-' + Math.random().toString(36).slice(2, 8) + ')';
    const at = edit.selectionStart;
    const pad = at > 0 && edit.value[at - 1] !== '\n' ? '\n' : '';
    edit.value = edit.value.slice(0, at) + pad + token + '\n' + edit.value.slice(edit.selectionEnd);
    edit.selectionStart = edit.selectionEnd = at + pad.length + token.length + 1;
    const p = uploadBlob(c.id, file, 'screenshot.png')
      .then(url => { edit.value = edit.value.replace(token, '![' + name + '](' + url + ')'); })
      .catch(err => {
        edit.value = edit.value.replace(token + '\n', '').replace(token, '');
        toast('Could not upload ' + name + ': ' + err.message);
      });
    uploading.push(p);
    return p;
  }
  edit.addEventListener('paste', e => {
    const files = imagesIn(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(insertImage);
  });
  edit.addEventListener('dragover', e => { e.preventDefault(); edit.classList.add('is-dropping'); });
  edit.addEventListener('dragleave', () => edit.classList.remove('is-dropping'));
  edit.addEventListener('drop', e => {
    const files = imagesIn(e.dataTransfer);
    edit.classList.remove('is-dropping');
    if (!files.length) return;
    e.preventDefault();
    files.forEach(insertImage);
  });

  edit.addEventListener('blur', async () => {
    const c = card();
    /* Clicking away mid-upload must not save the placeholder: the textarea is
       hidden by then but its value is still the thing being written. */
    if (uploading.length) { await Promise.allSettled(uploading.splice(0)); }
    const v = edit.value;
    edit.hidden = true; view.hidden = false;
    try {
      await upsert(path, '#' + c.id, '#' + c.id + ' [data-f="card-desc"]',
        `<div class="card-desc" data-f="card-desc" hidden>${esc(v)}</div>`);
      fieldOf(c, 'card-desc').textContent = v;
    } catch (err) { toast('Could not save description: ' + err.message); }
    fill();
  });

  /* --- add-row buttons, popovers, list move, complete circle --- */
  dlg.addEventListener('click', e => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    const name = b.dataset.open;
    openedSecs.add(name);
    fill();
    const sec = dlg.querySelector('[data-sec="' + name + '"]');
    sec.hidden = false;
    /* The + beside the applied chips toggles: clicking it a second time is a
       way to put the picker away, and a click that only ever opens looks dead
       to anyone who cannot see the picker that is already open. */
    const pop = name === 'labels' ? dlg.querySelector('.label-pop')
              : name === 'members' ? dlg.querySelector('.member-pop')
              : name === 'attachments' ? dlg.querySelector('.att-row')
              : name === 'epic' ? dlg.querySelector('.epic-pop') : null;
    if (pop) pop.hidden = b.classList.contains('plus') ? !pop.hidden : false;
    if (name === 'checklists') sec.querySelector('.add-checklist input')?.focus();
    if (name === 'due') sec.querySelector('.due-date')?.focus();
    /* Scroll the picker into view, not just its section: when the section is
       already visible the browser scrolls nothing, and a picker that opens
       below the fold is indistinguishable from a button that did nothing. */
    (pop && !pop.hidden ? pop : sec).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  dlg.querySelector('.modal-list-chip').onclick = () => {
    const pop = dlg.querySelector('.list-pop');
    if (!pop.hidden) { pop.hidden = true; return; }
    const c = card();
    const here = c.closest('.list');
    pop.innerHTML = [...document.querySelectorAll('#lists .list')].map(l =>
      `<button class="list-pop-opt" type="button" data-l="${l.id}" ${l === here ? 'disabled' : ''}>${esc(l.querySelector('.list-title').textContent)}</button>`).join('');
    pop.hidden = false;
  };
  dlg.querySelector('.list-pop').addEventListener('click', e => {
    const b = e.target.closest('.list-pop-opt');
    if (!b) return;
    const c = card();
    const from = c.closest('.list')?.querySelector('.list-title')?.textContent;
    const dest = document.getElementById(b.dataset.l);
    const toName = dest.querySelector('.list-title').textContent;
    dlg.querySelector('.list-pop').hidden = true;
    dest.querySelector('.cards').appendChild(c);
    fill();
    moveVerified(path, c.id, '#' + dest.id + '-cards', 'append', '#' + dest.id + '-cards')
      .then(() => { if (from && from !== toName) logAct(path, c.id, 'moved ' + readField(c, 'card-title') + ' from ' + from + ' to ' + toName); })
      .catch(err => { toast('Could not move: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.done-circle').onclick = () => {
    const c = card();
    const now = readField(c, 'card-done') !== 'true';
    const p = writeField(path, c, 'card-done', now ? 'true' : '');
    renderCardFront(c); fill();
    p.catch(err => { toast('Could not update: ' + err.message); boardCtx.resync?.(); });
  };

  dlg.querySelector('[data-act="edit-desc"]').onclick = () => dlg.querySelector('.desc-view').click();

  /* --- checklists --- */
  dlg.querySelector('.add-checklist').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = e.target.name, name = inp.value.trim();
    if (!name) return;
    const c = card();
    await ensureCardContainers(path, c);
    const id = uid('K'), html = checklistHTML(id, name);
    inp.value = '';
    c.querySelector('#' + CSS.escape(c.id + '-checklists')).insertAdjacentHTML('beforeend', html);
    fill();
    postEventually(path, '#' + c.id + '-checklists', html, 'append')
      .then(() => logAct(path, c.id, 'added checklist ' + name + ' to ' + readField(c, 'card-title')))
      .catch(err => { toast('Could not add checklist: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.checklist-list').addEventListener('submit', async e => {
    if (!e.target.classList.contains('add-item')) return;
    e.preventDefault();
    const kId = e.target.closest('.checklist-block').dataset.k;
    const inp = e.target.text, text = inp.value.trim();
    if (!text) return;
    const id = uid('KI'), html = checkItemHTML(id, text);
    inp.value = '';
    document.getElementById(kId + '-items').insertAdjacentHTML('beforeend', html);
    fill();
    /* The composer stays open so a list can be typed straight through. */
    dlg.querySelector('.checklist-block[data-k="' + kId + '"] .add-item input')?.focus();
    postEventually(path, '#' + kId + '-items', html, 'append')
      .catch(err => { toast('Could not add item: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.checklist-list').addEventListener('change', async e => {
    const row = e.target.closest('.check-row');
    if (!row) return;
    const item = document.getElementById(row.dataset.i);
    const on = e.target.checked;
    const f = item.querySelector('[data-f="item-done"]');
    if (f) f.setAttribute('content', on ? 'true' : '');
    else item.insertAdjacentHTML('beforeend', metaHTML('item-done', on ? 'true' : ''));
    fill();
    setField(path, '#' + item.id, 'item-done', on ? 'true' : '')
      .catch(err => { toast('Could not tick item: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.checklist-list').addEventListener('click', async e => {
    const c = card();
    const del = e.target.closest('[data-act="del-checklist"]');
    if (del) {
      const kId = del.closest('.checklist-block').dataset.k;
      const name = readF(document.getElementById(kId), 'checklist-name');
      if (!confirm('Delete checklist "' + name + '"?')) return;
      document.getElementById(kId).remove();
      fill();
      PL.del(path, '#' + kId)
        .then(() => logAct(path, c.id, 'deleted checklist ' + name + ' from ' + readField(c, 'card-title')))
        .catch(err => { toast('Could not delete checklist: ' + err.message); boardCtx.resync?.(); });
      return;
    }

    /* Converting an item to a card moves the work out of the checklist, so the
       item is removed only once the card exists. */
    const conv = e.target.closest('[data-act="to-card"]');
    if (conv) {
      e.preventDefault();
      const item = document.getElementById(conv.closest('.check-row').dataset.i);
      const text = readF(item, 'item-text');
      const list = c.closest('.list');
      if (!list) return toast('Archived cards have nowhere to convert into.');
      const newId = uid('C'), html = cardHTML(newId, text);
      try {
        await PL.post(path, '#' + list.id + '-cards', html, 'append');
        list.querySelector('.cards').insertAdjacentHTML('beforeend', html);
        ctx.wireCard(document.getElementById(newId));
        await PL.del(path, '#' + item.id);
        item.remove();
        logAct(path, newId, 'converted ' + text + ' into a card');
        fill();
      } catch (err) { toast('Could not convert to card: ' + err.message); }
    }
  });

  /* --- comments --- */
  dlg.querySelector('.add-comment').addEventListener('submit', async e => {
    e.preventDefault();
    const ta = e.target.body, body = ta.value.trim();
    if (!body) return;
    const c = card(), me = whoami();
    await ensureCardContainers(path, c);
    const html = commentHTML(uid('M'), me.sub, me.name, body);
    ta.value = '';
    c.querySelector('#' + CSS.escape(c.id + '-comments')).insertAdjacentHTML('beforeend', html);
    fill();
    postEventually(path, '#' + c.id + '-comments', html, 'append')
      .then(() => logAct(path, c.id, 'commented on ' + readField(c, 'card-title')))
      .catch(err => { toast('Could not comment: ' + err.message); boardCtx.resync?.(); });
  });

  /* Ownership is checked here against the local identity, which is honest but
     cosmetic: with the board still open to `*`, nothing stops a crafted
     request editing someone else's comment. The brief wants this enforced at
     the permission layer, and it can be — one rule per member keyed on their
     sub — but that needs real OIDC subs to key on. */
  dlg.querySelector('.comment-list').addEventListener('click', async e => {
    const row = e.target.closest('.comment-row');
    if (!row) return;
    const el = document.getElementById(row.dataset.c);
    const me = whoami();
    if (el.dataset.sub !== me.sub) return;

    if (e.target.closest('[data-act="del-comment"]')) {
      if (!confirm('Delete this comment?')) return;
      el.remove(); fill();
      PL.del(path, '#' + el.id)
        .catch(err => { toast('Could not delete comment: ' + err.message); boardCtx.resync?.(); });
      return;
    }
    if (e.target.closest('[data-act="edit-comment"]')) {
      const next = prompt('Edit comment', readF(el, 'comment-body'));
      if (next == null || !next.trim()) return;
      el.querySelector('[data-f="comment-body"]').textContent = next.trim();
      fill();
      PL.put(path, '#' + el.id + ' [data-f="comment-body"]',
        `<div data-f="comment-body">${esc(next.trim())}</div>`)
        .catch(err => { toast('Could not edit comment: ' + err.message); boardCtx.resync?.(); });
    }
  });

  /* --- attachments --- */
  dlg.querySelector('.att-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const c = card();
    await ensureCardContainers(path, c);
    try {
      const url = await uploadBlob(c.id, f, 'file');
      const p = addAttachment(path, c, url, f.name, f.type.startsWith('image/') ? 'image' : 'file');
      fill();
      p.then(() => logAct(path, c.id, 'attached ' + f.name + ' to ' + readField(c, 'card-title')))
       .catch(err => { toast('Could not attach: ' + err.message); boardCtx.resync?.(); });
    } catch (err) { toast('Could not upload: ' + err.message); }
  });

  /* Pasting a screenshot anywhere else in an open card attaches it, rather
     than doing nothing. The description handler preventDefaults first, so a
     paste aimed at the description never lands here as well. */
  dlg.addEventListener('paste', async e => {
    if (e.defaultPrevented) return;
    const files = imagesIn(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    const c = card();
    if (!c) return;
    await ensureCardContainers(path, c);
    for (const f of files) {
      try {
        const url = await uploadBlob(c.id, f, 'screenshot.png');
        const name = f.name || 'Pasted image';
        const p = addAttachment(path, c, url, name, 'image');
        fill();
        p.then(() => logAct(path, c.id, 'attached ' + name + ' to ' + readField(c, 'card-title')))
         .catch(err => { toast('Could not attach: ' + err.message); boardCtx.resync?.(); });
      } catch (err) { toast('Could not upload: ' + err.message); }
    }
  });

  dlg.querySelector('.add-link').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = e.target.url, url = inp.value.trim();
    if (!/^https?:\/\//.test(url)) return toast('Links need to start with http(s)://');
    const c = card();
    await ensureCardContainers(path, c);
    inp.value = '';
    const name = new URL(url).hostname;
    const p = addAttachment(path, c, url, name, IMAGE_RE.test(url) ? 'image' : 'link');
    fill();
    p.then(() => logAct(path, c.id, 'attached a link to ' + readField(c, 'card-title')))
     .catch(err => { toast('Could not attach link: ' + err.message); boardCtx.resync?.(); });
  });

  dlg.querySelector('.attachment-list').addEventListener('click', async e => {
    const li = e.target.closest('[data-a]');
    if (!li) return;
    const att = document.getElementById(li.dataset.a);
    const c = card();
    if (e.target.closest('[data-act="del-att"]')) {
      try { await PL.del(path, '#' + att.id); att.remove(); fill(); }
      catch (err) { toast('Could not remove attachment: ' + err.message); }
    }
  });

  dlg.querySelector('[data-act="archive"]').onclick = async () => {
    const c = card();
    close(false);
    c.querySelector('[data-act="archive-card"]').click();
  };
  dlg.querySelector('[data-act="delete"]').onclick = async () => {
    const c = card();
    if (!confirm('Delete this card? This cannot be undone.')) return;
    const parent = c.parentElement, next = c.nextElementSibling;
    close(false);
    c.remove();
    try { await PL.del(path, '#' + c.id); }
    catch (err) { next ? parent.insertBefore(c, next) : parent.appendChild(c); toast('Could not delete: ' + err.message); }
  };

  ctx.openCard = id => open(id, true);
  ctx.refreshModal = () => { if (cardId) fill(); };
  ctx.openCardId = () => cardId;

  /* A card URL pasted into Slack lands here. */
  const initial = new URLSearchParams(location.search).get('card');
  if (initial) open(initial, false);
}

/* Boards written before labels and members existed get the containers added,
   and opening a board is what makes you a member of it — there is no invite
   flow, so anyone who can reach the board belongs to it. */
async function ensureBoardContainers(path, me) {
  const defaults = { green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red', purple: 'Purple', blue: 'Blue', black: 'Black', plum: 'Plum' };
  if (!document.getElementById('labels')) {
    const html = '<div hidden id="labels">' +
      DEFAULT_LABELS.map(l => `<meta data-label="${l.id}" content="" data-hex="${l.hex}">`).join('') + '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
    try { await PL.post(path, 'body', html, 'append'); } catch (_) {}
  }
  for (const l of DEFAULT_LABELS) {
    const el = document.querySelector('#labels [data-label="' + l.id + '"]');
    if (el && el.getAttribute('content')) continue;
    /* An unnamed label would read as blank for everyone else, so the default
       is persisted rather than applied per-client. */
    if (el) el.setAttribute('content', defaults[l.id]);
    try {
      await upsert(path, '#labels', '#labels [data-label="' + l.id + '"]',
        `<meta data-label="${l.id}" content="${defaults[l.id]}" data-hex="${l.hex}">`);
    } catch (_) {}
  }

  if (!document.getElementById('members')) {
    document.body.insertAdjacentHTML('beforeend', '<div hidden id="members"></div>');
    try { await PL.post(path, 'body', '<div hidden id="members"></div>', 'append'); } catch (_) {}
  }
  if (!document.getElementById('epics')) {
    document.body.insertAdjacentHTML('beforeend', '<div hidden id="epics"></div>');
    try { await PL.post(path, 'body', '<div hidden id="epics"></div>', 'append'); } catch (_) {}
  }
  if (!document.getElementById('activity')) {
    document.body.insertAdjacentHTML('beforeend', '<div hidden id="activity"></div>');
    try { await PL.post(path, 'body', '<div hidden id="activity"></div>', 'append'); } catch (_) {}
  }
  const meHTML = `<meta data-sub="${esc(me.sub)}" data-name="${esc(me.name)}" data-picture="${esc(me.picture || '')}">`;
  if (!document.querySelector('#members [data-sub="' + me.sub + '"]')) {
    document.getElementById('members').insertAdjacentHTML('beforeend', meHTML);
  }
  try { await upsert(path, '#members', '#members [data-sub="' + me.sub + '"]', meHTML); } catch (_) {}
}

async function initBoard() {
  const path = location.pathname;
  const lists = document.getElementById('lists');

  /* Identity before anything else on the board: no guest accounts, so the
     first thing a new person does is say who they are. */
  const me = await requireProfile();

  editable(document.querySelector('.board-name'), v => {
    document.title = v + ' — Board';
    return PL.put(path, '[data-f="board-name"]', `<h1 class="board-name" contenteditable="plaintext-only" data-f="board-name" itemprop="name">${esc(v)}</h1>`);
  });

  /* --- add list --- */
  const alToggle = document.getElementById('add-list-toggle');
  const alForm = document.getElementById('add-list-form');
  alToggle.onclick = () => { alToggle.hidden = true; alForm.hidden = false; alForm.name.focus(); };
  alForm.querySelector('[data-cancel]').onclick = () => { alForm.hidden = true; alToggle.hidden = false; };
  alForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = alForm.name.value.trim();
    if (!name) return;
    const id = uid('L');
    const html = listHTML(id, name);
    lists.insertAdjacentHTML('beforeend', html);
    wireList(document.getElementById(id));
    alForm.name.value = '';
    alForm.name.focus();
    try { await PL.post(path, '#lists', html, 'append'); }
    catch (err) { document.getElementById(id).remove(); toast('Could not add list: ' + err.message); }
  });

  [...lists.querySelectorAll('.list')].forEach(wireList);
  const dnd = wireDragAndDrop(path, lists);

  /* Card counter per column. Counts change on add, move, archive, restore and
     every sync pass, so one observer beats chasing call sites. The badge is
     chrome, injected rather than stored. */
  function updateCounts() {
    document.querySelectorAll('#lists .list').forEach(l => {
      let c = l.querySelector('.list-count');
      if (!c) {
        c = document.createElement('span');
        c.className = 'list-count';
        l.querySelector('.list-title').after(c);
      }
      const n = String(l.querySelectorAll('.cards .card').length);
      /* Only write on change: assigning textContent replaces the text node
         even when the value is identical, which the observer sees as another
         mutation — an unconditional write here loops the observer forever
         and freezes the page. */
      if (c.textContent !== n) c.textContent = n;
    });
  }
  new MutationObserver(updateCounts).observe(lists, { childList: true, subtree: true });
  updateCounts();

  /* Board menu — background, archive and activity in one drawer. Chrome, so
     it is rendered rather than stored. */
  document.querySelector('.topbar').insertAdjacentHTML('beforeend',
    '<button class="btn-plain" type="button" id="menu-btn">Menu</button>');
  document.body.insertAdjacentHTML('beforeend',
    '<aside id="activity-panel" hidden>' +
    '<header><h2>Board menu</h2><button class="icon-btn" type="button" id="activity-close" aria-label="Close">&times;</button></header>' +
    '<section><button class="btn-ghost" type="button" id="edit-profile">Your name and photo</button></section>' +
    '<section class="sec-slack"><button class="btn-primary" type="button" id="send-digest">Send digest to Slack</button>' +
    '<p class="invite-hint">Posts automatically the first time someone opens this board each day.</p></section>' +
    '<section><h3>Filter by label</h3><div class="label-filter"></div></section>' +
    '<section><h3>Background</h3><div class="swatches bg-picker">' +
    BG.map(b => `<button class="bg-swatch" type="button" data-bg="${b}" title="${b}" aria-label="${b}"></button>`).join('') +
    '</div></section>' +
    '<section><h3>Archived</h3><ul class="archive-list"></ul></section>' +
    '<section><h3>Past goals</h3><ul class="past-goals"></ul></section>' +
    '<section><h3>Invite</h3><div class="invite-row"><input class="invite-link" readonly>' +
    '<button class="btn-ghost" type="button" id="copy-invite">Copy</button></div>' +
    '<p class="invite-hint">Anyone who signs in and opens this link joins the board. ' +
    'Accounts themselves live in Zitadel \u2014 add new people there first.</p></section>' +
    '<section><h3>Activity</h3><ul class="act-list"></ul></section></aside>');

  const panel = document.getElementById('activity-panel');
  document.getElementById('menu-btn').onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderActivity(); renderArchive(path); renderPastGoals(); renderLabelFilter(); }
  };
  document.getElementById('send-digest').onclick = () => sendDigest(path, { manual: true });
  panel.querySelector('.invite-link').value = location.origin + location.pathname;
  document.getElementById('copy-invite').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      toast('Board link copied');
    } catch (_) {
      panel.querySelector('.invite-link').select();
      toast('Copy blocked \u2014 the link is selected, press \u2318C');
    }
  };
  document.getElementById('activity-close').onclick = () => { panel.hidden = true; };

  applyBoardBg();
  initGoals(path);
  panel.querySelector('.bg-picker').addEventListener('click', async e => {
    const b = e.target.closest('.bg-swatch');
    if (!b) return;
    const was = document.body.dataset.bg;
    document.body.dataset.bg = b.dataset.bg;
    try {
      await setField(path, 'body', 'board-bg', b.dataset.bg);
      /* The home tile keeps its own copy so it can paint a swatch without
         opening the board, so it is updated too. */
      await setField('/index.html', '#' + document.body.dataset.board, 'bg', b.dataset.bg).catch(() => {});
      logAct(path, '', 'changed the board background to ' + b.dataset.bg);
    } catch (err) {
      document.body.dataset.bg = was;
      toast('Could not change background: ' + err.message);
    }
  });

  panel.querySelector('.archive-list').addEventListener('click', e => {
    const b = e.target.closest('[data-restore]');
    if (b) restoreArchived(path, b.dataset.restore, ctx);
  });

  /* Profile editor: your own avatar, top right, opens it. Saving writes the
     board's member record — which is what every avatar render reads — and
     localStorage, so new boards pick the profile up too. */
  document.body.insertAdjacentHTML('beforeend', `<dialog id="profile-dialog">
    <form method="dialog">
      <h3>Your profile</h3>
      <input type="text" name="name" placeholder="Your name" autocomplete="off" required>
      <div class="profile-row">
        <span class="profile-preview"></span>
        <label class="btn-ghost">Upload photo<input type="file" name="photo" accept="image/*" hidden></label>
      </div>
      <div class="dialog-actions">
        <button class="btn-ghost" type="submit" value="cancel">Cancel</button>
        <button class="btn-primary" type="submit" value="save">Save</button>
      </div>
    </form>
  </dialog>`);
  const pdlg = document.getElementById('profile-dialog');
  let pendingPicture = null;

  /* Named chips, in the label's own colour, showing how many cards carry it.
     Reads names live so a label renamed in a card is right here too. */
  function renderLabelFilter() {
    const box = panel.querySelector('.label-filter');
    if (!box) return;
    const counts = {};
    document.querySelectorAll('#lists .card').forEach(c =>
      readSet(c, 'card-labels').forEach(l => { counts[l] = (counts[l] || 0) + 1; }));
    box.innerHTML = labels().filter(l => counts[l.id]).map(l =>
      `<button class="chip chip-filter${boardCtx.labelFilter === l.id ? ' is-on' : ''}" type="button" ` +
      `data-label="${l.id}" style="background:${l.hex}">${esc(labelName(l.id))} ` +
      `<span class="chip-count">${counts[l.id]}</span></button>`).join('') ||
      '<p class="invite-hint">No labels in use on this board yet.</p>';
  }
  /* The card modal can add or rename a label, so the menu's filter list has to
     be rebuildable from outside this scope. */
  boardCtx.refreshLabelFilter = renderLabelFilter;

  panel.querySelector('.label-filter').addEventListener('click', e => {
    const b = e.target.closest('.chip-filter');
    if (!b) return;
    boardCtx.labelFilter = boardCtx.labelFilter === b.dataset.label ? null : b.dataset.label;
    applyFilter();
    renderLabelFilter();
  });

  document.getElementById('edit-profile').addEventListener('click', e => {
    const current = whoami();
    pendingPicture = current.picture || '';
    pdlg.querySelector('[name=name]').value = current.name;
    pdlg.querySelector('.profile-preview').innerHTML =
      avatarHTML(current.sub, current.name, 'avatar');
    pdlg.showModal();
  });

  pdlg.querySelector('[name=photo]').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const safe = f.name.replace(/[^\w.-]+/g, '_');
    const url = '/uploads/avatars/' + me.sub + '-' + Date.now().toString(36) + '-' + safe;
    try {
      const up = await fetch(url, { method: 'PUT', headers: { 'Content-Type': f.type || 'image/jpeg' }, body: f });
      if (!up.ok) throw new Error('upload \u2192 ' + up.status);
      pendingPicture = url;
      pdlg.querySelector('.profile-preview').innerHTML =
        `<img class="avatar avatar-img" src="${esc(url)}" alt="preview">`;
    } catch (err) { toast('Could not upload photo: ' + err.message); }
  });

  pdlg.querySelector('form').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const name = pdlg.querySelector('[name=name]').value.trim();
    if (!name) return;
    me.name = name;
    me.picture = pendingPicture || '';
    localStorage.setItem('board:me', JSON.stringify(me));
    const rec = `<meta data-sub="${esc(me.sub)}" data-name="${esc(me.name)}" data-picture="${esc(me.picture)}">`;
    try {
      await upsert(path, '#members', '#members [data-sub="' + me.sub + '"]', rec);
      const el = document.querySelector('#members [data-sub="' + me.sub + '"]');
      if (el) { el.setAttribute('data-name', me.name); el.setAttribute('data-picture', me.picture); }
      logAct(path, '', 'updated their profile');
      /* Repaint everywhere this face appears. */
      document.querySelectorAll('#lists .card').forEach(renderCardFront);
      const pres = document.getElementById('presence');
      if (pres) renderPresence(pres);
      boardCtx.refreshModal();
    } catch (err) { toast('Could not save profile: ' + err.message); }
  });

  /* Log in / log out, according to whether the server saw a session. */
  const authed = !!serverIdentity();
  document.querySelector('.topbar').insertAdjacentHTML('beforeend',
    authed ? '<a class="btn-plain" href="/auth/logout" title="Sign out">Log out</a>'
           : '<a class="btn-plain" href="/auth/login" title="Sign in">Log in</a>');

  /* Avatar strip is chrome, so boards written before presence existed get one
     rendered in rather than migrated. */
  if (!document.getElementById('avatars')) {
    document.querySelector('.topbar').insertAdjacentHTML('beforeend', '<div class="avatars" id="avatars"></div>');
  }

  const ctx = { dragging: dnd.dragging, wireList, wireCard };

  Object.assign(boardCtx, ctx);
  await ensureBoardContainers(path, me);
  initCardModal(path, boardCtx);
  document.querySelectorAll('#lists .card').forEach(renderCardFront);

  /* Trello's label toggle: collapse labels to colour bars and back. The rest
     of the shortcuts arrive with step 8. */
  addEventListener('keydown', e => {
    if (e.key !== 'l' && e.key !== 'L') return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    document.body.classList.toggle('labels-compact');
    localStorage.setItem('board:labelsCompact', document.body.classList.contains('labels-compact') ? '1' : '');
  });
  if (localStorage.getItem('board:labelsCompact')) document.body.classList.add('labels-compact');

  /* --- search: text, plus label: / member: / due: tokens --- */
  document.querySelector('.topbar .spacer').insertAdjacentHTML('afterend',
    '<input id="board-search" type="search" placeholder="Search\u2026" autocomplete="off" ' +
    'title="Plain text matches titles and descriptions; label:green, member:alice and due:overdue|soon|complete|none narrow further">');
  const search = document.getElementById('board-search');

  const cardMatches = (card, q) => q.split(/\s+/).every(tok => {
    if (tok.startsWith('label:')) {
      const n = tok.slice(6);
      return readSet(card, 'card-labels').some(l => l === n || labelName(l).toLowerCase().includes(n));
    }
    if (tok.startsWith('member:')) {
      const n = tok.slice(7);
      return readSet(card, 'card-members').some(s => s.toLowerCase().includes(n) || memberName(s).toLowerCase().includes(n));
    }
    if (tok.startsWith('due:')) {
      const n = tok.slice(4), st = dueState(card);
      return n === 'none' ? !st : st === n;
    }
    return (readField(card, 'card-title') + ' ' + readField(card, 'card-desc')).toLowerCase().includes(tok);
  });

  /* Two filters that stack: whatever is typed in search, and whichever face
     is toggled on. Kept separate so clicking a face doesn't clobber a search
     someone is in the middle of typing, and vice versa. */
  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    const sub = boardCtx.memberFilter;
    const lab = boardCtx.labelFilter;
    document.querySelectorAll('#lists .card').forEach(c => {
      const hidden = (!!q && !cardMatches(c, q)) ||
                     (!!sub && !readSet(c, 'card-members').includes(sub)) ||
                     (!!lab && !readSet(c, 'card-labels').includes(lab));
      c.classList.toggle('filtered-out', hidden);
    });
    /* A filtered column collapses to nothing, so the board needs to know a
       filter is on and keep a droppable area in every column. */
    document.body.classList.toggle('is-filtering', !!q || !!sub || !!lab);
  };

  /* Clicking a face shows only that person's cards; clicking it again, or the
     one already active, shows everything. */
  document.getElementById('avatars').addEventListener('click', e => {
    const b = e.target.closest('.avatar-btn');
    if (!b) return;
    boardCtx.memberFilter = boardCtx.memberFilter === b.dataset.sub ? null : b.dataset.sub;
    applyFilter();
    const pres = document.getElementById('presence');
    if (pres) renderPresence(pres);
  });
  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { search.value = ''; applyFilter(); search.blur(); }
  });
  /* Sync rebuilds cards without the class, so the filter is re-applied after
     every remote apply. */
  boardCtx.applyFilter = applyFilter;

  /* --- list view ---
     Linear-style rows, grouped and sorted. The board DOM is the data, so this
     is a projection of the cards in #lists, never a second copy: an observer
     re-renders the rows whenever sync, a filter or an edit touches a card, and
     the rows live outside #lists so rendering them can't feed the observer.
     Grouping and sorting happen here in the render, never by reordering the
     board — that would change the rank every other person sees. */
  const VIEW_KEY = 'board:view', GROUP_KEY = 'board:listGroup', SORT_KEY = 'board:listSort';
  const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  document.querySelector('.topbar .spacer').insertAdjacentHTML('afterend',
    '<div class="view-toggle" role="group" aria-label="View">' +
    '<button type="button" data-view="board">Board</button>' +
    '<button type="button" data-view="list">List</button>' +
    '<button type="button" data-view="epics">Epics</button></div>');
  document.querySelector('.board-canvas').insertAdjacentHTML('beforeend',
    '<section id="list-view" hidden>' +
    '<div class="lv-bar">' +
    '<label>Group by <select id="lv-group">' +
    '<option value="list">List</option><option value="member">Member</option><option value="label">Label</option><option value="epic">Epic</option>' +
    '</select></label>' +
    '<label>Sort <select id="lv-sort">' +
    '<option value="board">Board order</option><option value="due">Due date</option><option value="title">Title</option>' +
    '</select></label>' +
    '<button class="lv-reset" type="button" hidden>Reset group order</button>' +
    '<span class="lv-hint">Click a row to open the card &middot; drag a group header to reorder</span>' +
    '</div><div class="lv-groups"></div></section>');
  const lv = document.getElementById('list-view');
  const groupSel = document.getElementById('lv-group');
  const sortSel = document.getElementById('lv-sort');
  groupSel.value = pref(GROUP_KEY, 'list');
  sortSel.value = pref(SORT_KEY, 'board');
  const collapsedKey = 'board:listCollapsed:' + location.pathname;
  const collapsed = new Set(JSON.parse(pref(collapsedKey, '[]')));

  const listOf = c => c.closest('.list')?.querySelector('.list-title')?.textContent || 'Archive';
  const dueMs = c => { const d = readField(c, 'card-due'); return d ? parseDue(d).getTime() : Infinity; };
  const sorters = {
    board: () => 0,
    due: (a, b) => dueMs(a) - dueMs(b),
    title: (a, b) => readField(a, 'card-title').localeCompare(readField(b, 'card-title'), undefined, { sensitivity: 'base' }),
  };

  function groups(cards, by) {
    if (by === 'member') {
      const gs = boardMembers().map(m => ({ key: 'm:' + m.sub, name: m.name, cards: [] }));
      const none = { key: 'm:none', name: 'Unassigned', cards: [] };
      for (const c of cards) {
        const subs = readSet(c, 'card-members');
        if (!subs.length) { none.cards.push(c); continue; }
        subs.forEach(s => gs.find(g => g.key === 'm:' + s)?.cards.push(c));
      }
      return gs.concat(none).filter(g => g.cards.length);
    }
    if (by === 'label') {
      const gs = labels().map(l => ({ key: 'l:' + l.id, name: labelName(l.id), hex: l.hex, cards: [] }));
      const none = { key: 'l:none', name: 'No label', cards: [] };
      for (const c of cards) {
        const ids = readSet(c, 'card-labels');
        if (!ids.length) { none.cards.push(c); continue; }
        ids.forEach(id => gs.find(g => g.key === 'l:' + id)?.cards.push(c));
      }
      return gs.concat(none).filter(g => g.cards.length);
    }
    if (by === 'epic') {
      const gs = epics().map(e => ({ key: 'e:' + e.id, name: epicName(e), cards: [] }));
      const none = { key: 'e:none', name: 'No epic', cards: [] };
      for (const c of cards) (gs.find(g => g.key === 'e:' + readField(c, 'card-epic')) || none).cards.push(c);
      return gs.concat(none).filter(g => g.cards.length);
    }
    /* By list: every list shows, empty or not, so the structure matches the board. */
    return [...document.querySelectorAll('#lists .list')].map(l => ({
      key: 'list:' + l.id,
      name: l.querySelector('.list-title')?.textContent || '',
      cards: cards.filter(c => c.closest('.list') === l),
    }));
  }

  function rowHTML(c, by) {
    const state = dueState(c);
    const due = readField(c, 'card-due');
    const done = readField(c, 'card-done') === 'true' || inDoneList(c);
    const duePill = state
      ? `<span class="due-pill" data-state="${state}">${state === 'complete' ? '&#10003; ' : ''}${esc(fmtDue(due))}</span>`
      : done ? '<span class="due-pill" data-state="complete">&#10003;</span>' : '';
    const chips = readSet(c, 'card-labels').map(l => {
      const def = labelDef(l);
      return def ? `<span class="chip" style="background:${def.hex}">${esc(labelName(l))}</span>` : '';
    }).join('');
    const faces = readSet(c, 'card-members').map(s => avatarHTML(s, memberName(s), 'avatar avatar-sm')).join('');
    return `<div class="lrow${done ? ' is-done' : ''}" data-card="${c.id}" role="button" tabindex="0">` +
      `<span class="lrow-title">${esc(readField(c, 'card-title'))}</span>` +
      `<span class="lrow-labels">${chips}</span>` +
      (by !== 'list' ? `<span class="lrow-list">${esc(listOf(c))}</span>` : '') +
      `<span class="lrow-due">${duePill}</span>` +
      `<span class="lrow-members">${faces}</span></div>`;
  }

  /* The board's column order is workflow; the list's group order is attention.
     Each person keeps their own, per grouping mode. Groups it does not name
     (a new list, a new label) follow in natural order, so nothing vanishes. */
  const orderKey = by => 'board:listOrder:' + location.pathname + ':' + by;
  const groupOrder = by => { try { return JSON.parse(pref(orderKey(by), '[]')); } catch (_) { return []; } };
  function ordered(gs, by) {
    const order = groupOrder(by);
    if (!order.length) return gs;
    const rank = k => { const i = order.indexOf(k); return i < 0 ? Infinity : i; };
    return gs.map((g, i) => [g, i]).sort((a, b) => (rank(a[0].key) - rank(b[0].key)) || (a[1] - b[1])).map(p => p[0]);
  }

  function renderListView() {
    const by = groupSel.value, sort = sorters[sortSel.value] || sorters.board;
    const cards = [...document.querySelectorAll('#lists .card:not(.filtered-out)')];
    lv.querySelector('.lv-reset').hidden = !groupOrder(by).length;
    lv.querySelector('.lv-groups').innerHTML = ordered(groups(cards, by), by).map(g => {
      const rows = g.cards.slice().sort(sort);
      const shut = collapsed.has(g.key);
      return `<section class="lgroup${shut ? ' is-collapsed' : ''}" data-key="${esc(g.key)}">` +
        `<h2 class="lgroup-head" draggable="true" title="Drag to reorder">` +
        `<span class="lgroup-grip" aria-hidden="true">&#8942;&#8942;</span>` +
        `<button class="lgroup-toggle" type="button" aria-expanded="${!shut}">` +
        `<span class="lgroup-chev">&#8964;</span>` +
        (g.hex ? `<span class="lgroup-swatch" style="background:${g.hex}"></span>` : '') +
        `${esc(g.name)} <span class="lgroup-count">${rows.length}</span></button></h2>` +
        `<div class="lgroup-rows">${rows.map(c => rowHTML(c, by)).join('') ||
          '<p class="lrow-empty">No cards</p>'}</div></section>`;
    }).join('') || '<p class="lrow-empty">Nothing matches.</p>';
  }

  /* Coalesce bursts (a sync tick touches many cards) into one paint, and skip
     the work entirely while the board view is showing — it is redrawn on the
     way in. */
  let lvDirty = true, lvQueued = false;
  const inListView = () => document.body.classList.contains('view-list');
  const inEpicsView = () => document.body.classList.contains('view-epics');
  function scheduleListRender() {
    lvDirty = true;
    if (lvQueued || !(inListView() || inEpicsView())) return;
    lvQueued = true;
    requestAnimationFrame(() => {
      lvQueued = false; lvDirty = false;
      if (inListView()) renderListView();
      if (inEpicsView()) renderEpicsView();
    });
  }
  new MutationObserver(scheduleListRender).observe(document.getElementById('lists'),
    { childList: true, subtree: true, attributes: true, characterData: true });
  for (const id of ['labels', 'members', 'epics']) {
    const el = document.getElementById(id);
    if (el) new MutationObserver(scheduleListRender).observe(el, { childList: true, subtree: true, attributes: true });
  }

  function setView(v) {
    document.body.classList.toggle('view-list', v === 'list');
    document.body.classList.toggle('view-epics', v === 'epics');
    lv.hidden = v !== 'list';
    ev.hidden = v !== 'epics';
    document.querySelectorAll('.view-toggle [data-view]').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.view === v ? 'true' : 'false'));
    setPref(VIEW_KEY, v);
    if (v === 'list' && lvDirty) { lvDirty = false; renderListView(); }
    if (v === 'epics') { lvDirty = false; renderEpicsView(); }
  }
  document.querySelector('.view-toggle').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  groupSel.onchange = () => { setPref(GROUP_KEY, groupSel.value); renderListView(); };
  sortSel.onchange = () => { setPref(SORT_KEY, sortSel.value); renderListView(); };

  lv.addEventListener('click', e => {
    const t = e.target.closest('.lgroup-toggle');
    if (t) {
      const sec = t.closest('.lgroup'), key = sec.dataset.key;
      collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      setPref(collapsedKey, JSON.stringify([...collapsed]));
      sec.classList.toggle('is-collapsed', collapsed.has(key));
      t.setAttribute('aria-expanded', String(!collapsed.has(key)));
      return;
    }
    const row = e.target.closest('.lrow');
    if (row) boardCtx.openCard(row.dataset.card);
  });
  lv.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.lrow');
    if (row) { e.preventDefault(); boardCtx.openCard(row.dataset.card); }
  });

  /* Reordering groups: HTML5 drag on the header, like lists on the board. The
     board's own document-level drag handlers ignore anything that is not a
     .card or .list, so these never collide with them. A drop lands the moved
     group above the target when the pointer is over the top half of the
     target's header, otherwise below it — a tall group (Done, 125 rows) is
     "below" for almost its whole height, which is what a person means. */
  let dragKey = null;
  const clearDropMarks = () => lv.querySelectorAll('.drop-before, .drop-after').forEach(g =>
    g.classList.remove('drop-before', 'drop-after'));
  lv.addEventListener('dragstart', e => {
    const head = e.target.closest('.lgroup-head');
    if (!head) return;
    dragKey = head.closest('.lgroup').dataset.key;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragKey);
    requestAnimationFrame(() => head.closest('.lgroup').classList.add('is-dragging'));
  });
  const dropSide = (group, y) => {
    const h = group.querySelector('.lgroup-head').getBoundingClientRect();
    return y < h.top + h.height / 2 ? 'before' : 'after';
  };
  lv.addEventListener('dragover', e => {
    if (!dragKey) return;
    const group = e.target.closest('.lgroup');
    if (!group || group.dataset.key === dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const side = dropSide(group, e.clientY);
    if (!group.classList.contains('drop-' + side)) {
      clearDropMarks();
      group.classList.add('drop-' + side);
    }
  });
  lv.addEventListener('drop', e => {
    if (!dragKey) return;
    const group = e.target.closest('.lgroup');
    if (!group || group.dataset.key === dragKey) return;
    e.preventDefault();
    const by = groupSel.value;
    const keys = [...lv.querySelectorAll('.lgroup')].map(g => g.dataset.key).filter(k => k !== dragKey);
    const at = keys.indexOf(group.dataset.key) + (dropSide(group, e.clientY) === 'after' ? 1 : 0);
    keys.splice(at, 0, dragKey);
    setPref(orderKey(by), JSON.stringify(keys));
    dragKey = null;
    renderListView();
  });
  lv.addEventListener('dragend', () => {
    dragKey = null;
    clearDropMarks();
    lv.querySelector('.lgroup.is-dragging')?.classList.remove('is-dragging');
  });
  lv.querySelector('.lv-reset').onclick = () => {
    try { localStorage.removeItem(orderKey(groupSel.value)); } catch (_) {}
    renderListView();
  };
  /* --- epics view ---
     Each epic is a section: progress computed from its tasks (never typed),
     a target date, its description, the tasks beneath it, and a composer that
     adds a task already attached. Unattached shows the active work that
     belongs to nothing — Done is left out of that count because a finished
     task with no epic is history, not a gap. */
  document.querySelector('.board-canvas').insertAdjacentHTML('beforeend',
    '<section id="epics-view" hidden>' +
    '<div class="lv-bar"><button class="btn-primary" type="button" id="epic-add">+ New epic</button>' +
    '<label>Sort <select id="ev-sort"><option value="due">Target date</option>' +
    '<option value="progress">Progress</option><option value="name">Name</option></select></label>' +
    '<span class="lv-hint">A task counts as done when ticked or in a Done list</span></div>' +
    '<div class="ev-groups"></div></section>');
  const ev = document.getElementById('epics-view');
  const evSort = document.getElementById('ev-sort');
  evSort.value = pref('board:epicSort', 'due');
  evSort.onchange = () => { setPref('board:epicSort', evSort.value); renderEpicsView(); };
  const evCollapsedKey = 'board:epicsCollapsed:' + location.pathname;
  const evCollapsed = new Set(JSON.parse(pref(evCollapsedKey, '["unattached"]')));
  let editingEpic = null; /* an epic id, 'new', or null */

  const epicSorters = {
    due: (a, b) => (readField(a, 'epic-due') || '9999').localeCompare(readField(b, 'epic-due') || '9999'),
    progress: (a, b) => epicProgress(b).pct - epicProgress(a).pct,
    name: (a, b) => epicName(a).localeCompare(epicName(b), undefined, { sensitivity: 'base' }),
  };
  /* A week's warning for an epic, where a task gets a day. */
  function epicDueState(ep, p) {
    const due = readField(ep, 'epic-due');
    if (!due) return null;
    if (p.total && p.done === p.total) return 'complete';
    const ms = parseDue(due).getTime() - Date.now();
    return ms < 0 ? 'overdue' : ms < 7 * 864e5 ? 'soon' : 'upcoming';
  }
  function epicFormHTML(ep) {
    const name = ep ? epicName(ep) : '', due = ep ? readField(ep, 'epic-due') : '', desc = ep ? readField(ep, 'epic-desc') : '';
    return `<form class="epic-form" data-epic="${ep ? ep.id : ''}">` +
      `<input class="epic-f-name" name="name" placeholder="Epic name" value="${esc(name)}" required maxlength="80" autocomplete="off">` +
      `<label class="epic-f-due-l">Target date <input class="epic-f-due" name="due" type="date" value="${esc(due)}"></label>` +
      `<textarea class="epic-f-desc" name="desc" placeholder="What is this epic for?" rows="3">${esc(desc)}</textarea>` +
      `<div class="epic-form-row"><button class="btn-primary" type="submit">${ep ? 'Save' : 'Create epic'}</button>` +
      `<button class="btn-ghost" type="button" data-act="cancel-epic">Cancel</button>` +
      (ep ? `<button class="btn-ghost danger" type="button" data-act="delete-epic">Delete epic</button>` : '') +
      `</div></form>`;
  }
  function renderEpicsView() {
    const active = document.activeElement;
    /* Never redraw under an open form — a sync tick would wipe what someone is
       typing. Submit and cancel clear editingEpic first, so the redraw that
       removes the form is never blocked by focus still sitting inside it. The
       composer is different: keep its text and focus across the redraw so a
       just-added task appears without stealing the caret. */
    if (editingEpic && ev.contains(active) && active.closest('.epic-form')) { lvDirty = true; return; }
    const keep = ev.contains(active) && active.matches('.epic-add-task input')
      ? { id: active.closest('.epic-group').dataset.epic, v: active.value } : null;

    const sort = epicSorters[evSort.value] || epicSorters.due;
    const lists = [...document.querySelectorAll('#lists .list')];
    const firstOpen = lists.find(l => !DONE_LIST.test(l.querySelector('.list-title')?.textContent || '')) || lists[0];
    const listOptions = lists.map(l =>
      `<option value="${l.id}"${l === firstOpen ? ' selected' : ''}>${esc(l.querySelector('.list-title')?.textContent || '')}</option>`).join('');
    const eps = epics().sort(sort);
    const html = eps.map(ep => {
      if (editingEpic === ep.id) return `<section class="lgroup epic-group" data-epic="${ep.id}" data-key="${ep.id}">${epicFormHTML(ep)}</section>`;
      const tasks = epicTasks(ep).filter(c => !c.classList.contains('filtered-out'));
      const p = epicProgress(ep), st = epicDueState(ep, p), due = readField(ep, 'epic-due'), desc = readField(ep, 'epic-desc');
      const shut = evCollapsed.has(ep.id);
      return `<section class="lgroup epic-group${shut ? ' is-collapsed' : ''}" data-epic="${ep.id}" data-key="${ep.id}">` +
        `<h2 class="lgroup-head epic-head"><button class="lgroup-toggle" type="button" aria-expanded="${!shut}">` +
        `<span class="lgroup-chev">&#8964;</span><span class="epic-title">&#9670; ${esc(epicName(ep))}</span>` +
        `<span class="epic-progress"><span class="progress"><span style="width:${p.pct}%"></span></span>` +
        `<span class="epic-progress-text">${p.done}/${p.total} &middot; ${p.pct}%</span></span>` +
        (st ? `<span class="due-pill" data-state="${st}" title="Target date">${st === 'complete' ? '&#10003; ' : ''}${esc(fmtDue(due))}</span>` : '') +
        `</button><button class="btn-ghost epic-edit" type="button" data-act="edit-epic">Edit</button></h2>` +
        (desc ? `<div class="epic-desc-view">${md(desc)}</div>` : '') +
        `<div class="lgroup-rows">${tasks.map(c => rowHTML(c, 'epic')).join('') || '<p class="lrow-empty">No tasks yet</p>'}` +
        `<form class="epic-add-task"><input name="title" placeholder="Add a task\u2026" autocomplete="off" maxlength="200">` +
        `<select name="list" aria-label="Add to list">${listOptions}</select><button class="btn-ghost" type="submit">Add</button></form>` +
        `</div></section>`;
    }).join('');
    const orphans = [...document.querySelectorAll('#lists .card:not(.filtered-out)')].filter(c => !epicOf(c) && !isDone(c));
    const shutO = evCollapsed.has('unattached');
    const orphanHTML = `<section class="lgroup epic-group${shutO ? ' is-collapsed' : ''}" data-key="unattached">` +
      `<h2 class="lgroup-head epic-head"><button class="lgroup-toggle" type="button" aria-expanded="${!shutO}">` +
      `<span class="lgroup-chev">&#8964;</span>Unattached <span class="lgroup-count">${orphans.length}</span>` +
      `<span class="epic-note">active tasks with no epic</span></button></h2>` +
      `<div class="lgroup-rows">${orphans.map(c => rowHTML(c, 'epic')).join('') ||
        '<p class="lrow-empty">Every active task belongs to an epic.</p>'}</div></section>`;
    ev.querySelector('.ev-groups').innerHTML =
      (editingEpic === 'new' ? `<section class="lgroup epic-group" data-key="new">${epicFormHTML(null)}</section>` : '') +
      (eps.length || editingEpic === 'new' ? '' :
        '<p class="lrow-empty ev-empty">No epics yet. Create one to gather tasks under a bigger goal.</p>') +
      html + orphanHTML;
    if (keep) {
      const inp = ev.querySelector(`.epic-group[data-epic="${keep.id}"] .epic-add-task input`);
      if (inp) { inp.value = keep.v; inp.focus(); }
    }
  }
  const startEditing = id => { editingEpic = id; renderEpicsView(); ev.querySelector('.epic-f-name')?.focus(); };
  document.getElementById('epic-add').onclick = () => startEditing('new');

  ev.addEventListener('click', async e => {
    const tog = e.target.closest('.lgroup-toggle');
    if (tog) {
      const key = tog.closest('.lgroup').dataset.key;
      evCollapsed.has(key) ? evCollapsed.delete(key) : evCollapsed.add(key);
      setPref(evCollapsedKey, JSON.stringify([...evCollapsed]));
      renderEpicsView();
      return;
    }
    if (e.target.closest('[data-act="edit-epic"]')) return startEditing(e.target.closest('.epic-group').dataset.epic);
    if (e.target.closest('[data-act="cancel-epic"]')) { editingEpic = null; renderEpicsView(); return; }
    if (e.target.closest('[data-act="delete-epic"]')) {
      const id = e.target.closest('.epic-form').dataset.epic;
      const ep = document.getElementById(id), name = epicName(ep), n = epicTasks(ep).length;
      if (!confirm(`Delete "${name}"?` + (n ? ` Its ${n} task${n === 1 ? '' : 's'} stay on the board, unattached.` : ''))) return;
      ep.remove();
      editingEpic = null;
      renderEpicsView();
      document.querySelectorAll('#lists .card').forEach(renderCardFront);
      try { await PL.del(path, '#' + id); logAct(path, '', 'deleted epic ' + name); }
      catch (err) { toast('Could not delete epic: ' + err.message); boardCtx.resync?.(); }
      return;
    }
    const row = e.target.closest('.lrow');
    if (row) boardCtx.openCard(row.dataset.card);
  });
  ev.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.lrow');
    if (row) { e.preventDefault(); boardCtx.openCard(row.dataset.card); }
  });

  ev.addEventListener('submit', async e => {
    const f = e.target;
    if (f.classList.contains('epic-form')) {
      e.preventDefault();
      const name = f.name.value.trim(), due = f.due.value, desc = f.desc.value.trim();
      if (!name) return;
      editingEpic = null;
      if (f.dataset.epic) {
        const ep = document.getElementById(f.dataset.epic);
        const writes = [];
        if (name !== epicName(ep)) writes.push(writeField(path, ep, 'epic-name', name));
        if (due !== readField(ep, 'epic-due')) writes.push(writeField(path, ep, 'epic-due', due));
        if (desc !== readField(ep, 'epic-desc')) {
          fieldOf(ep, 'epic-desc').textContent = desc;
          writes.push(upsert(path, '#' + ep.id, '#' + ep.id + ' [data-f="epic-desc"]',
            `<div class="epic-desc" data-f="epic-desc" hidden>${esc(desc)}</div>`));
        }
        renderEpicsView();
        document.querySelectorAll('#lists .card').forEach(renderCardFront);
        Promise.all(writes).catch(err => { toast('Could not save epic: ' + err.message); boardCtx.resync?.(); });
      } else {
        try { await createEpic(path, name, due, desc); logAct(path, '', 'created epic ' + name); }
        catch (err) { toast('Could not create epic: ' + err.message); }
        renderEpicsView();
      }
      return;
    }
    if (f.classList.contains('epic-add-task')) {
      e.preventDefault();
      const title = f.title.value.trim();
      const list = document.getElementById(f.list.value);
      if (!title || !list) return;
      const epicId = f.closest('.epic-group').dataset.epic;
      const cid = uid('C');
      const html = cardHTML(cid, title).replace('<meta data-f="card-epic" content="">',
        `<meta data-f="card-epic" content="${esc(epicId)}">`);
      list.querySelector('.cards').insertAdjacentHTML('beforeend', html);
      const cardEl = document.getElementById(cid);
      wireCard(cardEl);
      renderCardFront(cardEl);
      f.title.value = '';
      try {
        await PL.post(path, '#' + list.id + '-cards', html, 'append');
        logAct(path, cid, 'added ' + title + ' to ' + (list.querySelector('.list-title')?.textContent || '') +
          ' under ' + epicName(document.getElementById(epicId)));
      } catch (err) { cardEl.remove(); toast('Could not add task: ' + err.message); }
    }
  });

  boardCtx.openEpic = id => {
    setView('epics');
    if (id) {
      evCollapsed.delete(id);
      renderEpicsView();
      ev.querySelector(`.epic-group[data-epic="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  setView(pref(VIEW_KEY, 'board'));

  /* --- keyboard shortcuts ---
     n new card \u00b7 e edit description \u00b7 space assign self \u00b7 d due date \u00b7
     c archive \u00b7 l label text (above) \u00b7 / search \u00b7 esc close.
     Like Trello, card shortcuts act on the card under the pointer, or the open
     card when the modal is up. */
  let hoverCard = null;
  lists.addEventListener('mouseover', e => { hoverCard = e.target.closest('.card'); });
  lists.addEventListener('mouseleave', () => { hoverCard = null; });

  addEventListener('keydown', async e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    const typing = a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
    if (typing) return;              /* esc while typing is handled per-editor */

    const dlg = document.getElementById('card-modal');
    const openId = boardCtx.openCardId();
    const target = openId ? document.getElementById(openId) : hoverCard;

    switch (e.key) {
      case '/':
        e.preventDefault(); search.focus(); search.select(); break;
      case 'q': {
        e.preventDefault();
        boardCtx.memberFilter = boardCtx.memberFilter === me.sub ? null : me.sub;
        applyFilter();
        const pres = document.getElementById('presence');
        if (pres) renderPresence(pres);
        toast(boardCtx.memberFilter ? 'Showing only your cards' : 'Showing all cards');
        break;
      }
      case 'Escape': {
        document.getElementById('activity-panel').hidden = true;
        if (boardCtx.memberFilter || boardCtx.labelFilter || search.value) {
          boardCtx.memberFilter = null;
          boardCtx.labelFilter = null;
          search.value = '';
          applyFilter();
          const pres = document.getElementById('presence');
          if (pres) renderPresence(pres);
        }
        break;
      }
      case 'n': {
        e.preventDefault();
        const first = document.querySelector('#lists .list');
        if (first) { first.querySelector('[data-act="add-card"]').click(); }
        break;
      }
      case 'e':
        if (openId) { e.preventDefault(); dlg.querySelector('.desc-view').click(); }
        break;
      case ' ':
        if (target) {
          e.preventDefault();
          try {
            const had = readSet(target, 'card-members').includes(me.sub);
            await toggleInSet(path, target, 'card-members', me.sub);
            logAct(path, target.id, (had ? 'unassigned themselves from ' : 'assigned themselves to ') + readField(target, 'card-title'));
            boardCtx.refreshModal();
          } catch (err) { toast('Could not assign: ' + err.message); }
        }
        break;
      case 'd':
        if (target) {
          e.preventDefault();
          if (!openId) boardCtx.openCard(target.id);
          setTimeout(() => dlg.querySelector('.due-date').focus(), 100);
        }
        break;
      case 'c':
        if (target && !openId) {
          e.preventDefault();
          target.querySelector('[data-act="archive-card"]').click();
          hoverCard = null;
        }
        break;
    }
  });

  renderActivity();
  trimActivity(path);
  /* After the board is rendered, so the digest reflects what is actually on
     screen rather than a half-built DOM. */
  setTimeout(() => sendDigest(path).catch(() => {}), 2500);
  startPresence(path, me);
  startSync(path, ctx);

  function wireList(list) {
    const id = list.id;
    const cards = list.querySelector('.cards');
    const form = list.querySelector('.quick-add');
    const toggle = list.querySelector('[data-act="add-card"]');

    const listTitle = list.querySelector('.list-title');
    listTitle.removeAttribute('contenteditable');
    if (!list.querySelector('[data-act="rename-list"]')) {
      list.querySelector('.list-head').insertAdjacentHTML('afterbegin', '');
      listTitle.insertAdjacentHTML('afterend',
        '<button class="icon-btn list-menu" type="button" data-act="rename-list" title="Rename list">&#9998;</button>');
    }
    list.querySelector('[data-act="rename-list"]').onclick = () => editOnDemand(listTitle);
    editable(listTitle, v =>
      PL.put(path, '#' + id + ' [data-f="list-name"]',
        `<h2 class="list-title" data-f="list-name" itemprop="name">${esc(v)}</h2>`));

    toggle.onclick = () => { toggle.hidden = true; form.hidden = false; form.title.focus(); };
    form.querySelector('[data-cancel]').onclick = () => { form.hidden = true; toggle.hidden = false; };

    /* Enter adds the card and keeps the composer open for the next one. */
    form.title.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      if (e.key === 'Escape') { form.hidden = true; toggle.hidden = false; }
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const title = form.title.value.trim();
      if (!title) return;
      /* Keep the composer in view as the list grows under it. */
      setTimeout(() => form.scrollIntoView({ block: 'nearest' }), 0);
      const cid = uid('C');
      const html = cardHTML(cid, title);
      cards.insertAdjacentHTML('beforeend', html);
      wireCard(document.getElementById(cid));
      form.title.value = '';
      form.title.focus();
      cards.scrollTop = cards.scrollHeight;
      try {
        await PL.post(path, '#' + id + '-cards', html, 'append');
        logAct(path, cid, 'added ' + title + ' to ' + list.querySelector('.list-title').textContent);
      } catch (err) { document.getElementById(cid).remove(); toast('Could not add card: ' + err.message); }
    });

    /* Collapse is a per-person view preference, so it stays on this device. */
    const setCollapsed = on => {
      list.classList.toggle('collapsed', on);
      const key = 'collapsed:' + location.pathname;
      const set = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
      on ? set.add(id) : set.delete(id);
      localStorage.setItem(key, JSON.stringify([...set]));
    };
    list.querySelector('[data-act="collapse"]').onclick = () =>
      setCollapsed(!list.classList.contains('collapsed'));
    /* A collapsed list hides its own menu — including the collapse button —
       so the whole list becomes the expand control. */
    list.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      if (list.classList.contains('collapsed')) setCollapsed(false);
    });

    list.querySelector('[data-act="archive-list"]').onclick = async () => {
      const prev = list.nextElementSibling;
      document.getElementById('archive').appendChild(list);
      try { await moveVerified(path, id, '#archive', 'append', '#archive'); }
      catch (err) { lists.insertBefore(list, prev); toast('Could not archive list: ' + err.message); }
    };

    list.querySelector('[data-act="move-all"]').onclick = async () => {
      const others = [...lists.querySelectorAll('.list')].filter(l => l !== list);
      if (!others.length) return toast('No other list to move cards to.');
      const target = others[0];
      const moving = [...cards.children];
      for (const card of moving) {
        target.querySelector('.cards').appendChild(card);
        try { await moveVerified(path, card.id, '#' + target.id + '-cards', 'append', '#' + target.id + '-cards'); }
        catch (err) { toast('Could not move ' + card.id + ': ' + err.message); break; }
      }
    };

    [...cards.querySelectorAll('.card')].forEach(wireCard);

    const collapsed = JSON.parse(localStorage.getItem('collapsed:' + location.pathname) || '[]');
    if (collapsed.includes(id)) list.classList.add('collapsed');
  }

  function wireCard(card) {
    const title = card.querySelector('.card-title');
    title.removeAttribute('contenteditable');   /* stored docs may carry it */
    editable(title, v =>
      PL.put(path, '#' + card.id + ' [data-f="card-title"]',
        `<div class="card-title" data-f="card-title" itemprop="name">${esc(v)}</div>`));

    /* Clicking anywhere on the card opens it; the pencil renames in place. */
    card.addEventListener('click', e => {
      if (e.target.closest('button') || title.isContentEditable) return;
      boardCtx.openCard(card.id);
    });

    renderCardFront(card);

    /* The archive control is chrome, not data, so it is rendered here rather
       than stored in the board document. */
    card.insertAdjacentHTML('beforeend',
      '<button class="card-edit" type="button" data-act="rename-card" title="Rename card" aria-label="Rename card">&#9998;</button>' +
      '<button class="card-archive" type="button" data-act="archive-card" title="Archive card" aria-label="Archive card">&#215;</button>');
    card.querySelector('[data-act="rename-card"]').onclick = e => {
      e.stopPropagation();
      editOnDemand(title);
    };

    /* Archiving is a MOVE into the board's archive container. Restoring later
       is the same MOVE in reverse, which is why the origin list is recorded
       first — as its own field, so it is a one-field write. */
    card.querySelector('[data-act="archive-card"]').onclick = async e => {
      e.stopPropagation();
      const parent = card.parentElement, next = card.nextElementSibling;
      document.getElementById('archive').appendChild(card);
      try {
        await setField(path, '#' + card.id, 'card-home', parent.id);
        await setField(path, '#' + card.id, 'card-archived-at', new Date().toISOString());
        const f = card.querySelector('[data-f="card-archived-at"]');
        if (!f) card.insertAdjacentHTML('beforeend', metaHTML('card-archived-at', new Date().toISOString()));
        await moveVerified(path, card.id, '#archive', 'append', '#archive');
        logAct(path, card.id, 'archived ' + card.querySelector('.card-title').textContent);
      } catch (err) {
        next ? parent.insertBefore(card, next) : parent.appendChild(card);
        toast('Could not archive card: ' + err.message);
      }
    };
  }

  window.wireCard = wireCard;
}

/* ---------- drag and drop (HTML5 native) ---------- */
function wireDragAndDrop(path, lists) {
  let dragged = null, kind = null, ph = null, origin = null;

  const placeholder = () => {
    if (!ph) { ph = document.createElement('div'); ph.className = 'placeholder'; }
    return ph;
  };

  /* --- edge auto-scroll, shared by mouse and touch drags ---
     dragover fires only a few times a second while the pointer sits parked
     at the viewport edge, so scrolling inside the event crawls. A rAF loop
     driven by the last known pointer position scrolls smoothly for as long
     as a drag is live — the board horizontally at the viewport edges, and a
     tall list vertically near its own top and bottom. */
  let dragPoint = null, scrolling = false;

  /* Placeholder placement lives here, once per frame, not in dragover —
     dragover fires continuously and repositioning on every event re-measures
     every card in the hovered list and re-dirties layout each time, which is
     what made dragging over an 88-card column stutter. The DOM is only
     touched when the insertion point actually changes. */
  let lastPlace = 0;
  function placePlaceholder(under) {
    lastPlace = Date.now();
    const el = dragged || (touch && touch.card);
    if (!el) return;
    const isCard = el.classList.contains('card');
    let container, after;
    if (isCard) {
      container = under && under.closest('.cards');
      if (!container) return;
      after = afterElement(container, dragPoint.y, '.card:not(.dragging):not(.filtered-out)', 'y');
    } else {
      container = lists;
      after = afterElement(lists, dragPoint.x, '.list:not(.dragging)', 'x');
    }
    const p = placeholder();
    if (p.parentElement === container && p.nextSibling === (after || null)) return;
    if (isCard) {
      p.style.height = el.offsetHeight + 'px';
      p.style.width = '';
    } else {
      p.style.width = el.offsetWidth + 'px';
      p.style.height = '60px';
    }
    after ? container.insertBefore(p, after) : container.appendChild(p);
  }

  function autoScrollTick() {
    if (!dragged && !(touch && touch.active)) { scrolling = false; dragPoint = null; return; }
    if (dragPoint) {
      const canvas = document.querySelector('.board-canvas');
      if (dragPoint.x > innerWidth - 64) canvas.scrollLeft += 14;
      else if (dragPoint.x < 64) canvas.scrollLeft -= 14;
      const under = document.elementFromPoint(dragPoint.x, dragPoint.y);
      const cont = under && under.closest('.cards');
      if (cont) {
        const r = cont.getBoundingClientRect();
        if (dragPoint.y > r.bottom - 52) cont.scrollTop += 10;
        else if (dragPoint.y < r.top + 52) cont.scrollTop -= 10;
      }
      placePlaceholder(under);
    }
    requestAnimationFrame(autoScrollTick);
  }
  const startAutoScroll = () => {
    if (!scrolling) { scrolling = true; requestAnimationFrame(autoScrollTick); }
  };

  document.addEventListener('dragstart', e => {
    const card = e.target.closest('.card');
    const list = e.target.closest('.list');
    if (card) { dragged = card; kind = 'card'; }
    else if (list) { dragged = list; kind = 'list'; }
    else return;
    origin = { parent: dragged.parentElement, next: dragged.nextElementSibling };
    document.body.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.id);
    startAutoScroll();
    requestAnimationFrame(() => dragged.classList.add('dragging'));
  });

  document.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragPoint = { x: e.clientX, y: e.clientY };
    /* The frame loop owns placement, but a throttled rAF (low-power mode)
       must not mean no placeholder at all — place from here at most once
       per 80ms as a floor. */
    if (Date.now() - lastPlace > 80) placePlaceholder(document.elementFromPoint(e.clientX, e.clientY));
  });

  document.addEventListener('drop', async e => {
    if (!dragged || !ph || !ph.parentElement) return cleanup();
    e.preventDefault();
    const el = dragged, back = origin;
    ph.parentElement.insertBefore(el, ph);
    cleanup();
    await commitDrop(el, back);
  });

  /* Optimistic: the element is already where it was dropped; one atomic MOVE
     follows, and a refused move puts it back where it came from. Shared by
     the mouse path above and the touch path below. */
  async function commitDrop(el, back) {
    const next = el.nextElementSibling;
    const destSel = next ? '#' + next.id : '#' + el.parentElement.id;
    const placement = next ? 'before' : 'append';
    const fromName = back.parent.closest('.list')?.querySelector('.list-title')?.textContent;
    const toName = el.closest('.list')?.querySelector('.list-title')?.textContent;
    try {
      await moveVerified(path, el.id, destSel, placement, '#' + el.parentElement.id);
      if (el.classList.contains('card') && fromName && toName && fromName !== toName) {
        logAct(path, el.id, 'moved ' + el.querySelector('.card-title').textContent + ' from ' + fromName + ' to ' + toName);
      }
    } catch (err) {
      back.next ? back.parent.insertBefore(el, back.next) : back.parent.appendChild(el);
      toast('Move failed, put it back: ' + err.message);
    }
  }

  /* --- touch: long-press to drag ---
     HTML5 drag and drop never fires on touch, so a 350ms still press picks
     the card up on a pointer-driven path that ends in the same commitDrop.
     A finger that moves before the timer fires is a scroll and is left
     entirely to the browser. */
  let touch = null;
  const stopScroll = e => e.preventDefault();

  lists.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const card = e.target.closest('.card');
    if (!card) return;
    touch = {
      card, x: e.clientX, y: e.clientY, id: e.pointerId, active: false, ghost: null,
      origin: { parent: card.parentElement, next: card.nextElementSibling },
    };
    touch.timer = setTimeout(() => {
      if (!touch) return;
      touch.active = true;
      /* From here the gesture is a drag, so the page must stop scrolling —
         a passive:false listener is the only thing that can veto it. */
      document.addEventListener('touchmove', stopScroll, { passive: false });
      const r = card.getBoundingClientRect();
      const g = card.cloneNode(true);
      g.classList.add('touch-ghost');
      g.style.width = r.width + 'px';
      g.style.left = r.left + 'px';
      g.style.top = r.top + 'px';
      document.body.appendChild(g);
      touch.ghost = g;
      touch.dx = touch.x - r.left;
      touch.dy = touch.y - r.top;
      card.classList.add('dragging');
      document.body.classList.add('is-dragging');
      startAutoScroll();
      if (navigator.vibrate) navigator.vibrate(25);
    }, 350);
  });

  document.addEventListener('pointermove', e => {
    if (!touch || e.pointerId !== touch.id) return;
    if (!touch.active) {
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) { clearTimeout(touch.timer); touch = null; }
      return;
    }
    touch.ghost.style.left = (e.clientX - touch.dx) + 'px';
    touch.ghost.style.top = (e.clientY - touch.dy) + 'px';
    dragPoint = { x: e.clientX, y: e.clientY };
    if (Date.now() - lastPlace > 80) placePlaceholder(document.elementFromPoint(e.clientX, e.clientY));
  });

  async function endTouch(e, commit) {
    if (!touch || (e && e.pointerId !== touch.id)) return;
    clearTimeout(touch.timer);
    document.removeEventListener('touchmove', stopScroll);
    const t = touch;
    touch = null;
    if (!t.active) return;
    t.ghost?.remove();
    document.body.classList.remove('is-dragging');
    t.card.classList.remove('dragging');
    if (commit && ph && ph.parentElement) {
      ph.parentElement.insertBefore(t.card, ph);
      ph.remove();
      await commitDrop(t.card, t.origin);
    } else if (ph && ph.parentElement) {
      ph.remove();
    }
  }
  document.addEventListener('pointerup', e => endTouch(e, true));
  document.addEventListener('pointercancel', e => endTouch(e, false));

  document.addEventListener('dragend', cleanup);

  function cleanup() {
    document.body.classList.remove('is-dragging');
    if (dragged) dragged.classList.remove('dragging');
    if (ph && ph.parentElement) ph.remove();
    dragged = null; kind = null; origin = null;
  }

  return { dragging: () => dragged !== null || !!(touch && touch.active) };

  function afterElement(container, pos, sel, axis) {
    const els = [...container.querySelectorAll(':scope > ' + sel)];
    return els.find(el => {
      const b = el.getBoundingClientRect();
      return pos < (axis === 'y' ? b.top + b.height / 2 : b.left + b.width / 2);
    });
  }
}

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.classList.contains('home')) initHome();
  else if (document.body.classList.contains('board')) initBoard();
});
