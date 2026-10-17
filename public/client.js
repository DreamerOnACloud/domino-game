// Firestore-backed client. There is no game server: the two browsers write to
// the same room document inside transactions and Firestore pushes updates back
// through listeners. All rule logic comes from game-rules.js, the same module
// the WebSocket server uses.
//
// Access control lives in firestore.rules, not here.
import { FIREBASE_CONFIG, USE_EMULATORS } from './firebase-config.js';
import * as G from './game-rules.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, runTransaction,
  collection, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = (s) => document.querySelector(s);
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

// ---------------------------------------------------------------- firebase
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
if (USE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

let uid = null;
let code = null;           // current room code
let room = null;           // room document data
let hand = null;           // { tiles: [...], pips }
let unsubs = [];
let selected = null;
let boardDoc = null;       // rooms/{code}/private/board — the tile chain lives here
let extra = { pt: {} };    // published pip totals of both players
let lastBoardLen = -1;
let lastFreshSeq = -1;
let busy = false;

const roomRef = () => doc(db, 'rooms', code);
const handRef = () => doc(db, 'rooms', code, 'hands', uid);
const ptRef = (who) => doc(db, 'rooms', code, 'pipTotals', who);
const pileRef = () => doc(db, 'rooms', code, 'private', 'pile');
const boardRef = () => doc(db, 'rooms', code, 'private', 'board');

const seatOf = (r, u) => (r && r.members['0'] === u ? 0 : r && r.members['1'] === u ? 1 : -1);
const mySeat = () => seatOf(room, uid);
const oppSeat = () => 1 - mySeat();
let quitBy = null;                  // '0' | '1' | null — the seat that left
const hasQuit = () => quitBy !== null;

/** the pure-module shape, rebuilt from the room document + the board document */
function stateFrom(r, b) {
  const bd = b || boardDoc || {};
  const board = bd.board || [];
  return {
    board,
    left: board.length ? bd.left : null,
    right: board.length ? bd.right : null,
    seq: bd.seq || 0,
    turn: r.turn,
    passes: r.passes || 0,
    round: r.round || 1,
    scores: [r.scores['0'], r.scores['1']],
    over: r.over,
    roundResult: r.result,
    matchOver: r.matchOver,
  };
}
// The room document no longer carries the board. Keeping the tile-chain algebra
// (set comparisons over up to 28 tiles) in the room's rule made every write to
// the room pay for it, and the next-round deal — four writes in one transaction
// — went over the rules engine's expression budget because of it.
const roomDoc = (s) => ({
  turn: s.turn,
  passes: s.passes,
  boardSize: s.board.length,
  over: s.over,
  result: s.roundResult,
});
const boardFields = (s) => ({
  board: s.board,
  left: s.board.length ? s.left : -1,
  right: s.board.length ? s.right : -1,
  seq: s.seq,
});
const emptyBoard = () => ({ board: [], left: -1, right: -1, seq: 0 });

// ---------------------------------------------------------------- screens
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
const showMsg = (m) => { $('#home-msg').textContent = m; };
const hideError = () => { $('#home-msg').textContent = ''; };
function report(msg) {
  if ($('#home').classList.contains('active')) showMsg(msg);
  toast(msg);
}

// ---------------------------------------------------------------- room wiring
function subscribe(newCode) {
  for (const u of unsubs) u();
  unsubs = [];
  code = newCode;
  quitBy = null;
  localStorage.setItem('dominoCode', code);
  history.replaceState(null, '', '#' + code);

  unsubs.push(onSnapshot(
    roomRef(),
    (snap) => {
      if (!snap.exists()) {
        report('That game is gone — start a new one');
        localStorage.removeItem('dominoCode');
        code = null;
        return;
      }
      room = snap.data();
      const seat = mySeat();
      if (seat < 0) {
        report('That game is already full (two players)');
        localStorage.removeItem('dominoCode');
        code = null;
        return;
      }
      if (room.status === 'waiting') {
        show('lobby');
        $('#lobby-code').textContent = code;
        $('#lobby-url').textContent = location.origin + '/' + '#' + code;
        if (hasQuit()) overlay();      // the host left before anyone joined
        return;
      }
      render();
      if (room.over && !room.result && !hasQuit()) settle();
      // both players ready to continue: deal the next round
      if (room.over && room.result && !hasQuit() && room.rematch['0'] && room.rematch['1']) startNextRound();
      catchUpDeal();
    },
    (err) => {
      // A listener that dies silently is exactly how a view goes stale.
      console.error('room listener failed', err);
      report('Lost the connection to the game — retrying');
      setTimeout(() => { if (code) subscribe(code); }, 1500);
    },
  ));

  unsubs.push(onSnapshot(
    boardRef(),
    (snap) => {
      boardDoc = snap.exists() ? snap.data() : null;
      if (room && room.status === 'playing') render();
    },
    (err) => {
      console.error('board listener failed', err);
      setTimeout(() => { if (code) subscribe(code); }, 1500);
    },
  ));

  unsubs.push(onSnapshot(
    handRef(),
    (snap) => {
      hand = snap.exists() ? snap.data() : null;
      if (room && room.status === 'playing') render();
    },
    (err) => {
      console.error('hand listener failed', err);
      setTimeout(() => { if (code) subscribe(code); }, 1500);
    },
  ));

  unsubs.push(onSnapshot(collection(db, 'rooms', code, 'quit'), (snap) => {
    quitBy = snap.empty ? null : snap.docs[0].id;
    if (!room) return;
    // Whoever left, this table is finished: no card, no dead board — straight
    // back to the start screen. (This is also the lobby's only repaint path,
    // since the room document never changes there.)
    if (hasQuit()) { leaveToHome(); return; }
    if (room.status !== 'waiting') render();
  }, (err) => console.error('quit listener failed', err)));

  unsubs.push(onSnapshot(collection(db, 'rooms', code, 'pipTotals'), (snap) => {
    extra.pt = {};
    snap.forEach((d) => { extra.pt[d.id] = d.data().pips; });
    maybeSettle();
  }));
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!room || !hand || !boardDoc) return;
  show('game');
  const seat = mySeat();
  const st = stateFrom(room, boardDoc);
  const opp = 1 - seat;

  $('#score-you').textContent = st.scores[seat];
  $('#score-opp').textContent = st.scores[opp];
  $('#round-no').textContent = 'Round ' + (room.round || 1);
  $('#bones').textContent = 'bones ' + (room.boneyardCount || 0);

  const myTurn = st.turn === seat && !st.over && !hasQuit();
  $('#turn-line').textContent = hasQuit()
    ? 'Game over'
    : st.over
      ? 'Round over'
      : myTurn ? 'Your turn' : "Opponent's turn";
  $('#turn-line').style.color = myTurn ? '#e0b559' : '';

  const oh = $('#opp-hand');
  oh.innerHTML = '';
  for (let i = 0; i < (room.handCounts[String(opp)] || 0); i++) oh.appendChild(el('div', 'back'));

  const bd = $('#board');
  bd.innerHTML = '';
  let freshSeq = -1;
  for (const t of st.board) if (t.seq > freshSeq) freshSeq = t.seq;
  if (freshSeq > lastFreshSeq) lastFreshSeq = freshSeq;
  const fresh = st.board.length !== lastBoardLen ? freshSeq : -1;
  for (const t of st.board) {
    const n = tileEl(t.a, t.b);
    if (t.seq === fresh) n.classList.add('fresh');
    bd.appendChild(n);
  }
  if (st.board.length !== lastBoardLen) {
    lastBoardLen = st.board.length;
    requestAnimationFrame(() => {
      const newest = [...bd.children].find((c) => c.classList.contains('fresh'));
      if (newest) newest.scrollIntoView({ inline: 'center', block: 'nearest' });
    });
  }

  const playable = !st.over && !hasQuit() && st.turn === seat ? G.playableIds(st, hand.tiles) : [];
  const hd = $('#hand');
  hd.innerHTML = '';
  for (const t of hand.tiles) {
    const n = tileEl(t.a, t.b);
    const ok = playable.includes(t.id);
    n.classList.add(ok ? 'playable' : 'notplayable');
    if (selected && selected.id === t.id) n.classList.add('sel');
    n.onclick = () => {
      if (!ok) return toast("That tile doesn't fit either end");
      selected = selected && selected.id === t.id ? null : t;
      render();
    };
    hd.appendChild(n);
  }

  controls(myTurn, playable);
  overlay();
}

function controls(myTurn, playable) {
  const c = $('#controls');
  c.innerHTML = '';
  if (!room || room.over || hasQuit()) return;

  const bd = boardDoc || emptyBoard();
  if (selected) {
    const ends = [];
    if (!bd.board.length) ends.push({ end: null, label: 'Play' });
    else {
      const fits = (v) => selected.a === v || selected.b === v;
      if (fits(bd.left)) ends.push({ end: 'left', label: `${bd.left} end`, cls: 'left end' });
      if (fits(bd.right)) ends.push({ end: 'right', label: `${bd.right} end`, cls: 'right end' });
    }
    for (const e of ends) {
      const b = el('button', e.cls || '', e.label);
      b.onclick = () => {
        const t = selected;
        if (!t) return;           // second tap before the re-render landed
        selected = null;
        b.disabled = true;
        playTile(t.id, e.end);
      };
      c.appendChild(b);
    }
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = () => { selected = null; render(); };
    c.appendChild(cancel);
    return;
  }

  if (myTurn) {
    if (G.canDraw(stateFrom(room, boardDoc), hand.tiles, new Array(room.boneyardCount || 0))) {
      const b = el('button', '', 'Draw from boneyard');
      b.onclick = () => doDraw();
      c.appendChild(b);
    } else if (G.canPass(stateFrom(room, boardDoc), hand.tiles, new Array(room.boneyardCount || 0))) {
      const b = el('button', '', 'Pass');
      b.onclick = () => doPass();
      c.appendChild(b);
    } else {
      c.appendChild(el('div', 'hint', 'Tap a tile to play it'));
    }
  }
}

function overlay() {
  const old = $('#overlay');
  if (old) old.remove();
  if (!room || !room.over) return;   // a quit never puts a card on screen

  const r = room.result;
  const seat = mySeat();
  const box = el('div', 'overlay');
  box.id = 'overlay';
  const card = el('div', 'card');

  if (!r) {
    card.appendChild(el('h3', '', 'Round over'));
    card.appendChild(el('p', '', 'Working out the score…'));
  } else {
    const youWon = r.winner === seat;
    card.appendChild(el('h3', '', r.winner === -1 ? 'Blocked game' : youWon ? 'You win!' : 'Opponent wins'));
    card.appendChild(el('p', '',
      r.reason === 'domino' ? `${youWon ? 'You' : 'Opponent'} played every tile.`
        : 'Both players blocked. Lowest pip count wins.'));
    card.appendChild(el('div', 'scroll', `Score  —  You ${room.scores[String(seat)]} · Opp ${room.scores[String(1 - seat)]}`));
    if (room.matchOver) card.appendChild(el('p', '', room.scores[String(seat)] >= G.TARGET_SCORE ? '🏆 Match won!' : 'Match lost.'));
    const iAmReady = !!room.rematch[String(seat)];
    const bothReady = iAmReady && !!room.rematch[String(1 - seat)];
    const b = el('button', '', room.matchOver ? 'New match' : 'Next round');
    b.onclick = () => rematch();
    // "waiting for the other player" is a lie once the other player has said yes
    if (bothReady) { b.disabled = true; b.textContent = 'Starting the next round…'; }
    else if (iAmReady) { b.disabled = true; b.textContent = 'Waiting for the other player…'; }
    card.appendChild(b);
    const ready = [room.rematch['0'], room.rematch['1']].filter(Boolean).length;
    if (ready) card.appendChild(el('p', '', `${ready}/2 ready`));

    // leaving the table from here too, same hold as everywhere else
    const q = el('button', 'quit quit-big', null);
    q.appendChild(el('span', 'lbl', 'QUIT GAME'));
    wireQuit(q);
    card.insertBefore(q, b.nextSibling);
  }
  box.appendChild(card);
  document.body.appendChild(box);
}

// ---------------------------------------------------------------- actions
async function createRoom() {
  const c = String(Math.floor(100000 + Math.random() * 900000));
  const ref = doc(db, 'rooms', c);
  if ((await getDoc(ref)).exists()) return createRoom();
  await setDoc(ref, {
    status: 'waiting',
    members: { '0': uid, '1': '' },
    turn: 0,
    passes: 0,
    boardSize: 0,
    handCounts: { '0': 0, '1': 0 },
    boneyardCount: 0,
    round: 0,
    scores: { '0': 0, '1': 0 },
    over: false, result: null, matchOver: false,
    rematch: { '0': false, '1': false },
    createdAt: Date.now(),
  });
  subscribe(c);
}

async function joinRoom(c) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'rooms', c);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('No game with that code');
    const r = snap.data();
    if (r.status !== 'waiting') throw new Error('That game has already started');
    if (r.members['1'] !== '') throw new Error('That game is already full (two players)');

    const deal = G.startRound(1);
    const pile = {};
    deal.boneyard.forEach((t, i) => { pile[String(i)] = t; });

    tx.set(ref, {
      ...r,
      status: 'playing',
      members: { '0': r.members['0'], '1': uid },
      turn: deal.state.turn,
      passes: 0,
      boardSize: 0,
      handCounts: { '0': 7, '1': 7 },
      boneyardCount: 14,
      round: 1,
      scores: { '0': 0, '1': 0 },
      over: false, result: null, matchOver: false,
      rematch: { '0': false, '1': false },
    });
    tx.set(doc(db, 'rooms', c, 'hands', r.members['0']), { tiles: deal.hands[0], pips: G.pips(deal.hands[0]), round: 1 });
    tx.set(doc(db, 'rooms', c, 'hands', uid), { tiles: deal.hands[1], pips: G.pips(deal.hands[1]), round: 1 });
    tx.set(doc(db, 'rooms', c, 'private', 'pile'), { top: 0, tiles: pile, round: 1 });
    tx.set(doc(db, 'rooms', c, 'private', 'board'), { ...emptyBoard(), round: 1 });
  });
  subscribe(c);
}

async function playTile(tileId, end) {
  if (busy) return;
  busy = true;
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef());
      const hs = await tx.get(handRef());
      const bs = await tx.get(boardRef());
      const r = rs.data();
      const st = stateFrom(r, bs.data());
      const seat = seatOf(r, uid);
      const res = G.play(st, hs.data().tiles, seat, tileId, end);
      if (res.err) throw new Error(res.err);

      // Playing your last tile ends the round: play() reports it, and only the
      // caller knows whether the hand it was given is now empty.
      const dominoed = res.dominoed === true;
      const over = dominoed || res.state.over;

      // Full-document set, not a partial update: the rules read fields this
      // write does not change (scores, members, boardSize), and a partial update
      // does not hand them those fields — they come back undefined and the
      // whole rule evaluation fails.
      tx.set(roomRef(), {
        ...r,
        ...roomDoc(res.state),
        handCounts: { ...r.handCounts, [String(seat)]: res.hand.length },
        over,
        result: res.state.roundResult,
        scores: { '0': res.state.scores[0], '1': res.state.scores[1] },
        matchOver: res.state.matchOver,
      });
      tx.update(boardRef(), boardFields(res.state));
      tx.update(handRef(), { tiles: res.hand, pips: G.pips(res.hand), round: r.round });
    });
  } catch (e) {
    report(friendly(e));
  } finally {
    busy = false;
  }
}

async function doDraw() {
  if (busy) return;
  busy = true;
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef());
      const hs = await tx.get(handRef());
      const ps = await tx.get(pileRef());
      const bs = await tx.get(boardRef());
      const r = rs.data();
      const pile = ps.data();
      const topTile = pile.tiles[String(pile.top)];
      const res = G.draw(stateFrom(r, bs.data()), hs.data().tiles, Object.values(pile.tiles).slice(pile.top), seatOf(r, uid));
      if (res.err) throw new Error(res.err);

      tx.set(roomRef(), {
        ...r,
        handCounts: { ...r.handCounts, [String(seatOf(r, uid))]: res.hand.length },
        boneyardCount: r.boneyardCount - 1,
      });
      tx.update(handRef(), { tiles: [...hs.data().tiles, topTile], pips: G.pips([...hs.data().tiles, topTile]), round: r.round });
      tx.update(pileRef(), { top: pile.top + 1, round: r.round });
    });
  } catch (e) {
    report(friendly(e));
  } finally {
    busy = false;
  }
}

async function doPass() {
  if (busy) return;
  busy = true;
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef());
      const hs = await tx.get(handRef());
      const bs = await tx.get(boardRef());
      const r = rs.data();
      const res = G.pass(stateFrom(r, bs.data()), hs.data().tiles, [], seatOf(r, uid));
      if (res.err) throw new Error(res.err);
      tx.set(roomRef(), {
        ...r,
        over: res.blocked ? true : r.over,
        result: res.blocked ? null : r.result,
        turn: res.blocked ? r.turn : res.state.turn,
        passes: res.state.passes,
      });
    });
  } catch (e) {
    report(friendly(e));
  } finally {
    busy = false;
  }
}

// Publishing pip totals (verified against hand docs by the rules) lets either
// player settle the round without being able to read the other's hand.
async function settle() {
  if (!room || !room.over || room.result || !hand) return;
  const seat = mySeat();
  const myUid = room.members[String(seat)];
  try {
    const mine = await getDoc(ptRef(myUid));
    if (!mine.exists() || mine.data().pips !== hand.pips) await setDoc(ptRef(myUid), { pips: hand.pips });
  } catch (e) {
    report(friendly(e));
  }
  return maybeSettle();
}

let settling = false;
async function maybeSettle() {
  if (settling || !room || !room.over || room.result || hasQuit()) return;
  const p0 = extra.pt[room.members['0']];
  const p1 = extra.pt[room.members['1']];
  if (p0 == null || p1 == null) return;
  settling = true;
  try {
    let winner, pts, reason;
    const zero0 = room.handCounts['0'] === 0;
    const zero1 = room.handCounts['1'] === 0;
    if (zero0 || zero1) {
      reason = 'domino';
      winner = zero0 ? 0 : 1;
      pts = winner === 0 ? p1 : p0;
    } else {
      reason = 'blocked';
      if (p0 === p1) { winner = -1; pts = 0; }
      else { winner = p0 < p1 ? 0 : 1; pts = Math.abs(p0 - p1); }
    }
    const scores = { '0': room.scores['0'], '1': room.scores['1'] };
    if (winner >= 0) scores[String(winner)] += pts;
    await setDoc(roomRef(), {
      ...room,
      result: { winner, pts, reason },
      scores,
      matchOver: scores['0'] >= G.TARGET_SCORE || scores['1'] >= G.TARGET_SCORE,
    });
  } catch (e) {
    report(friendly(e));
  } finally {
    settling = false;
  }
}

async function rematch() {
  if (busy) return;
  busy = true;
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef());
      const r = rs.data();
      if (!r || !r.over || !r.result) throw new Error('The round is not settled yet');
      const seat = seatOf(r, uid);
      if (seat < 0 || r.rematch[String(seat)]) return;   // already said yes
      tx.set(roomRef(), { ...r, rematch: { ...r.rematch, [String(seat)]: true } });
    });
  } catch (e) {
    report(friendly(e));
  } finally {
    busy = false;
  }
}

// The tap only says "I am ready". Once both seats are ready the round starts by
// itself — previously the deal happened inside the tap handler, but only for a
// player who had *already* tapped, so with both at "ready" nobody ever dealt.
let dealing = false;
async function startNextRound() {
  if (dealing) return;
  dealing = true;
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef());
      const r = rs.data();
      if (!r || !r.over || !r.result) return;                  // already dealt
      if (!r.rematch['0'] || !r.rematch['1']) return;           // not both ready
      const prev = r.result.winner >= 0 ? r.result.winner : 0;
      const seed = Math.floor(Math.random() * 2147483647) + 1;
      // A full-document set, not a partial update: with an update the rules see
      // only the touched fields in request.resource.data, so reading members or
      // scores (which this write does not change) dereferences null and the
      // whole evaluation fails.
      tx.set(roomRef(), {
        ...r,
        status: 'playing',
        turn: prev,
        passes: 0,
        boardSize: 0,
        handCounts: { '0': 7, '1': 7 },
        boneyardCount: 14,
        round: r.round + 1,
        over: false, result: null,
        rematch: { '0': false, '1': false },
        // the deck for the new round, as a seed both clients can deal from
        dealSeed: seed,
      });
      tx.set(boardRef(), { ...emptyBoard(), round: r.round + 1 });
      // The hands and the pile are deliberately NOT written here. A player may
      // only write their own hand, and this transaction is one player's — so
      // each client seeds its own hand from dealSeed (see catchUpDeal), and
      // whoever holds seat 0 writes the pile.
    });
  } catch (e) {
    // Losing the race to deal is the normal outcome, not an error: the other
    // client's write landed first, which is exactly why the rules refused this
    // one. Only speak up if the round is still sitting there undealt.
    const now = await getDoc(roomRef()).then((s) => s.data()).catch(() => null);
    if (now && now.over && now.rematch && now.rematch['0'] && now.rematch['1']) report(friendly(e));
  } finally {
    dealing = false;
  }
}

// A deterministic deck from a seed the room publishes, so both clients deal the
// same tiles without one of them having to write the other's hand.
function seededDeck(seed) {
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return G.shuffle(G.newDeck(), rand);
}

// The deal is one player's write; the hands are each player's own. This picks up
// the new round's tiles from what the deal published.
let catching = false;
async function catchUpDeal() {
  if (catching || !room || !hand || room.status !== 'playing' || room.dealSeed == null) return;
  if (hand.round === room.round) return;                  // already on this round
  catching = true;
  try {
    const seat = mySeat();
    if (seat < 0) return;
    const { hands, boneyard } = G.deal(seededDeck(room.dealSeed));
    await setDoc(handRef(), { tiles: hands[seat], pips: G.pips(hands[seat]), round: room.round });
    if (seat === 0) {
      const pile = {};
      boneyard.forEach((t, i) => { pile[String(i)] = t; });
      await setDoc(pileRef(), { top: 0, tiles: pile, round: room.round });
    }
  } catch (e) {
    // Same as the deal: if my hand already carries this round, someone got there
    // first (or an earlier attempt did) and there is nothing to report.
    const h = await getDoc(handRef()).then((s) => (s.exists() ? s.data() : null)).catch(() => null);
    if (!h || h.round !== room.round) report(friendly(e));
  } finally {
    catching = false;
  }
}

/** Drop the table completely and go back to create/join. */
function leaveToHome() {
  for (const u of unsubs) u();
  unsubs = [];
  try { localStorage.removeItem('dominoCode'); } catch {}
  history.replaceState(null, '', location.pathname);
  code = null; room = null; hand = null; quitBy = null; selected = null;
  boardDoc = null;
  lastBoardLen = -1; lastFreshSeq = -1;
  const ov = $('#overlay');
  if (ov) ov.remove();
  hideError();
  show('home');
}

async function quitGame() {
  if (busy || !room || hasQuit()) return;
  const seat = mySeat();
  if (seat < 0) return;
  busy = true;
  try {
    await setDoc(doc(db, 'rooms', code, 'quit', String(seat)), { at: Date.now() });
  } catch (e) {
    report(friendly(e));
  } finally {
    busy = false;
  }
}

function friendly(e) {
  const m = (e && e.message) || String(e);
  if (/permission|PERMISSION_DENIED|insufficient/i.test(m)) return 'Blocked by the game rules — that move is not allowed';
  return m;
}

// ---------------------------------------------------------------- boot
$('#btn-create').onclick = () => {
  hideError();
  if (!uid) return showMsg('Still signing in — try again in a second');
  createRoom().catch((e) => report(friendly(e)));
};
$('#btn-join').onclick = () => {
  hideError();
  const c = $('#code-input').value.replace(/\D/g, '');
  if (c.length !== 6) return showMsg('Enter the 6-digit code');
  if (!uid) return showMsg('Still signing in — try again in a second');
  joinRoom(c).catch((e) => report(friendly(e)));
};
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

// Quitting ends the game for both players, so it takes a deliberate press: hold
// QUIT for two seconds, the button filling with a darker red as it goes.
const QUIT_HOLD_MS = 2000;
let quitHold = null;
let holdBtn = null;

function startHold(btn, e) {
  if (e && e.preventDefault) { try { e.preventDefault(); } catch {} }
  if (quitHold) return;
  if (room && hasQuit()) return;                     // nothing left to quit
  holdBtn = btn;
  document.documentElement.classList.add('holding-quit');
  btn.classList.add('holding');
  quitHold = setTimeout(() => {
    quitHold = null;
    btn.classList.remove('holding');
    document.documentElement.classList.remove('holding-quit');
    quitGame();
  }, QUIT_HOLD_MS);
}

function cancelHold() {
  if (!quitHold) return;
  clearTimeout(quitHold);
  quitHold = null;
  if (holdBtn) holdBtn.classList.remove('holding');  // released early: just reset
  holdBtn = null;
  document.documentElement.classList.remove('holding-quit');
}

function wireQuit(btn) {
  if (!btn) return;
  // iOS starts a text selection / callout on a long press unless touchstart's
  // default is prevented, and that selection cancels the press.
  btn.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  btn.addEventListener('pointerdown', (e) => startHold(btn, e));
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointercancel', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// one in the game top bar, one on the "waiting for the other player" screen
wireQuit($('#btn-quit'));
wireQuit($('#btn-quit-lobby'));

// The selection menu can also be raised from a selectstart or a drag that the
// press itself starts, so those are blocked while the button is held.
for (const ev of ['selectstart', 'dragstart', 'contextmenu']) {
  document.addEventListener(ev, (e) => { if (quitHold) e.preventDefault(); }, true);
}

// Phones and background tabs get suspended, and a suspended tab stops hearing
// snapshots. Re-attach the listeners whenever the page comes back, so the view
// catches up instead of sitting on the snapshot it had when it went away.
let resyncing = false;
function resync() {
  if (resyncing || !code || !uid) return;
  resyncing = true;
  subscribe(code);
  setTimeout(() => { resyncing = false; }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resync();
});
window.addEventListener('focus', resync);
window.addEventListener('online', resync);

// Boot used to hang off onAuthStateChanged: if that callback did not deliver a
// user (a restored session can race the first sign-in), the app stayed on the
// home screen with a room already in the URL — no error, no subscribe, so the
// board never updated. Wait for auth to settle explicitly, then resume.
async function boot() {
  try {
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;

    const saved = localStorage.getItem('dominoCode') || location.hash.slice(1);
    if (!/^\d{6}$/.test(saved)) return;
    $('#code-input').value = saved;

    const snap = await getDoc(doc(db, 'rooms', saved));
    if (!snap.exists()) {
      localStorage.removeItem('dominoCode');
      return;
    }
    const r = snap.data();
    if (seatOf(r, uid) >= 0) subscribe(saved);                 // our room: resume
    else if (r.status === 'waiting' && r.members['1'] === '') await joinRoom(saved);
    else report('That game is already full (two players)');
  } catch (e) {
    report(friendly(e));                                       // never fail silently
  }
}
boot();
