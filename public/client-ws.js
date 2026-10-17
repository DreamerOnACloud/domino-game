const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const PIPS = {
  0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

function tileEl(a, b) {
  const t = el('div', 'tile' + (a === b ? ' double' : ''));
  const mk = (v) => {
    const h = el('div', 'half');
    for (let i = 0; i < 9; i++) {
      const c = el('div', 'p');
      if (PIPS[v].includes(i)) c.appendChild(el('i'));
      h.appendChild(c);
    }
    return h;
  };
  t.appendChild(mk(a));
  t.appendChild(el('div', 'divider'));
  t.appendChild(mk(b));
  return t;
}

let ws = null;
let S = null;              // latest server state
let selected = null;       // {id, a, b}
let wantToast = null;
let lastBoardLen = -1;
let lastFreshSeq = -1;

// ---------------------------------------------------------------- networking
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const saved = load();
    const hashCode = location.hash.slice(1);
    if (saved && saved.code && hashCode === saved.code) {
      // same browser, same table: take your seat back
      ws.send(JSON.stringify({ type: 'rejoin', code: saved.code, token: saved.token }));
    } else if (/^\d{6}$/.test(hashCode)) {
      // arrived through an invite link — join straight away
      $('#code-input').value = hashCode;
      clearPending = pending($('#btn-join'), 'Joining…');
      ws.send(JSON.stringify({ type: 'join', code: hashCode }));
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'error') {
      settle();
      if (/expired|unknown player|no game/i.test(m.message)) {
        try { localStorage.removeItem('domino'); } catch {}
      }
      return report(m.message);
    }
    if (m.type === 'joined') {
      settle();
      save({ code: m.code, token: m.token });
      history.replaceState(null, '', '#' + m.code);
      if (m.player === 0) show('lobby');
      $('#lobby-code').textContent = m.code;
      renderLobbyUrl();
      return;
    }
    if (m.type === 'state') {
      S = m;
      render();
    }
  };
  ws.onclose = () => {
    toast('Disconnected — reconnecting…');
    setTimeout(connect, 1200);
  };
}

const save = (o) => { try { localStorage.setItem('domino', JSON.stringify(o)); } catch {} };
const load = () => { try { return JSON.parse(localStorage.getItem('domino') || 'null'); } catch { return null; } };

function sendMsg(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

// ---------------------------------------------------------------- ui helpers
function show(which) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === which);
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// A tap must always produce visible feedback, on whichever screen is showing.
let clearPending = null;
function pending(btn, label) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  const done = () => { btn.disabled = false; btn.textContent = orig; };
  const timer = setTimeout(() => { if (clearPending === done) clearPending = null; done(); }, 6000);
  return () => { clearTimeout(timer); done(); };
}
function settle() {
  if (clearPending) { const f = clearPending; clearPending = null; f(); }
}
function report(msg) {
  if ($('#home').classList.contains('active')) showMsg(msg);
  toast(msg);
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!S) return;
  if (S.phase === 'waiting') { show('lobby'); $('#lobby-code').textContent = S.code; renderLobbyUrl(); return; }
  show('game');

  $('#score-you').textContent = S.scores[S.you];
  $('#score-opp').textContent = S.scores[1 - S.you];
  $('#round-no').textContent = 'Round ' + (S.round || 1);
  $('#bones').textContent = 'bones ' + S.boneyard;

  const myTurn = S.turn === S.you && !S.over;
  const oppOnline = S.online[1 - S.you];
  $('#turn-line').textContent = S.over
    ? 'Round over'
    : !oppOnline
      ? 'Opponent offline'
      : myTurn
        ? 'Your turn'
        : "Opponent's turn";
  $('#turn-line').style.color = myTurn ? '#e0b559' : '';

  // opponent hand backs
  const oh = $('#opp-hand');
  oh.innerHTML = '';
  for (let i = 0; i < S.counts[1 - S.you]; i++) oh.appendChild(el('div', 'back'));

  // board
  const bd = $('#board');
  bd.innerHTML = '';
  let freshSeq = -1;
  for (const t of S.board) if (t.seq > freshSeq) freshSeq = t.seq;
  if (freshSeq > lastFreshSeq) lastFreshSeq = freshSeq;
  const fresh = S.board.length && freshSeq === lastFreshSeq && S.board.length !== lastBoardLen ? freshSeq : -1;
  for (const t of S.board) {
    const n = tileEl(t.a, t.b);
    if (t.seq === fresh) n.classList.add('fresh');
    bd.appendChild(n);
  }
  if (S.board.length !== lastBoardLen) {
    lastBoardLen = S.board.length;
    requestAnimationFrame(() => {
      // keep the newest tile in view: scroll to whichever end it landed on
      const newest = [...bd.children].find((c) => c.classList.contains('fresh'));
      if (newest) newest.scrollIntoView({ inline: 'center', block: 'nearest' });
    });
  }

  // hand
  const hd = $('#hand');
  hd.innerHTML = '';
  for (const t of S.hand) {
    const n = tileEl(t.a, t.b);
    const ok = S.playable.includes(t.id);
    n.classList.add(ok ? 'playable' : 'notplayable');
    if (selected && selected.id === t.id) n.classList.add('sel');
    n.onclick = () => {
      if (!ok) return toast('That tile doesn\'t fit either end');
      selected = selected && selected.id === t.id ? null : t;
      render();
    };
    hd.appendChild(n);
  }

  renderControls(myTurn);
  renderOverlay();
}

function renderControls(myTurn) {
  const c = $('#controls');
  c.innerHTML = '';
  if (S.over) return;

  if (selected) {
    const ends = [];
    if (S.board.length === 0) ends.push({ end: null, label: 'Play' });
    else {
      const fits = (v) => selected.a === v || selected.b === v;
      if (fits(S.left)) ends.push({ end: 'left', label: `${S.left} end`, cls: 'left end' });
      if (fits(S.right)) ends.push({ end: 'right', label: `${S.right} end`, cls: 'right end' });
    }
    for (const e of ends) {
      const b = el('button', e.cls || 'end', e.label);
      b.onclick = () => {
        sendMsg({ type: 'play', tile: selected.id, end: e.end });
        selected = null;
      };
      c.appendChild(b);
    }
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = () => { selected = null; render(); };
    c.appendChild(cancel);
    return;
  }

  if (myTurn) {
    if (S.canDraw) {
      const b = el('button', '', 'Draw from boneyard');
      b.onclick = () => sendMsg({ type: 'draw' });
      c.appendChild(b);
    } else if (S.canPass) {
      const b = el('button', '', 'Pass');
      b.onclick = () => sendMsg({ type: 'pass' });
      c.appendChild(b);
    } else {
      c.appendChild(el('div', 'hint', 'Tap a tile to play it'));
    }
  }
}

function renderOverlay() {
  const old = $('#overlay');
  if (old) old.remove();
  if (!S.over) return;

  const r = S.roundResult;
  const youWon = r.winner === S.you;
  const box = el('div', 'overlay');
  box.id = 'overlay';
  const card = el('div', 'card');
  const title = el('h3', '', r.winner === -1 ? 'Blocked game' : youWon ? 'You win!' : 'Opponent wins');
  card.appendChild(title);

  let line;
  if (r.winner === -1) line = 'Nobody could play — tied, no score.';
  else if (r.reason === 'domino') line = `${youWon ? 'You' : 'Opponent'} played every tile.`;
  else line = 'Both players blocked. Lowest pip count wins.';
  card.appendChild(el('p', '', line));
  card.appendChild(el('div', 'scroll', `Score  —  You ${S.scores[S.you]} · Opp ${S.scores[1 - S.you]}`));

  if (S.matchOver) {
    const champ = el('p', '', S.scores[S.you] >= S.target ? '🏆 Match won!' : 'Match lost.');
    card.appendChild(champ);
  }

  const b = el('button', 'big primary', S.matchOver ? 'New match' : 'Next round');
  b.onclick = () => sendMsg({ type: 'rematch' });
  card.appendChild(b);

  const ready = S.rematch.filter(Boolean).length;
  if (ready > 0) card.appendChild(el('p', '', `${ready}/2 ready`));

  box.appendChild(card);
  document.body.appendChild(box);
}

// ---------------------------------------------------------------- boot
$('#btn-create').onclick = () => {
  hideError();
  if (!ws || ws.readyState !== 1) return showMsg('Still connecting — try again in a second');
  clearPending = pending($('#btn-create'), 'Creating…');
  sendMsg({ type: 'create' });
};
$('#btn-join').onclick = doJoin;
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  hideError();
  const code = $('#code-input').value.replace(/\D/g, '');
  if (code.length !== 6) return showMsg('Enter the 6-digit code');
  if (!ws || ws.readyState !== 1) return showMsg('Still connecting — try again in a second');
  clearPending = pending($('#btn-join'), 'Joining…');
  sendMsg({ type: 'join', code });
}
function showMsg(m) { $('#home-msg').textContent = m; }
function hideError() { $('#home-msg').textContent = ''; }

$('#btn-copy').onclick = async () => {
  const url = `${inviteBase()}/#${$('#lobby-code').textContent}`;
  try {
    await navigator.clipboard.writeText(url);
    $('#btn-copy').textContent = 'Copied!';
  } catch {
    $('#btn-copy').textContent = url;
  }
  setTimeout(() => { $('#btn-copy').textContent = 'Copy invite link'; }, 2000);
};

// The invite link must be an address the guest's device can actually open, so
// on localhost we swap in this machine's LAN address (served by /api/info).
let info = { lan: [] };
function inviteBase() {
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  if (local && info.lan && info.lan.length) return info.lan[0];
  return location.origin;
}
function renderLobbyUrl() {
  const code = $('#lobby-code').textContent;
  if (!/^\d{6}$/.test(code)) return;
  $('#lobby-url').textContent = inviteBase() + '/#' + code;
}
fetch('/api/info')
  .then((r) => r.json())
  .then((d) => { info = d; renderLobbyUrl(); })
  .catch(() => {});

const hash = location.hash.slice(1);
if (/^\d{6}$/.test(hash)) $('#code-input').value = hash;
connect();
