// Pure domino rules — no I/O, no globals.
//
// Shared by the WebSocket server (server.js) and the Firestore client
// (public/firestore-client.js) so there is exactly one implementation of the
// game. Every function is pure: it returns new values and never mutates its
// arguments, which is what lets a Firestore transaction compute the next state
// and write it in one shot.

export const TARGET_SCORE = 100;
export const HAND_SIZE = 7;

/** All 28 tiles of a double-six set, a <= b so the id is unique. */
export function newDeck() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) tiles.push({ id: `${a}${b}`, a, b });
  return tiles;
}

export function shuffle(arr, rand = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const pips = (hand) => hand.reduce((s, t) => s + t.a + t.b, 0);

/** First tile is the top of the pile; a draw takes index 0. */
export function deal(deck) {
  return {
    hands: [deck.slice(0, HAND_SIZE), deck.slice(HAND_SIZE, HAND_SIZE * 2)],
    boneyard: deck.slice(HAND_SIZE * 2),
  };
}

/** Highest double leads; otherwise the heaviest tile. Deterministic. */
export function chooseStarter(hands) {
  let best = -1;
  let starter = null;
  for (const p of [0, 1]) {
    for (const t of hands[p]) {
      if (t.a === t.b && t.a > best) {
        best = t.a;
        starter = p;
      }
    }
  }
  if (starter !== null) return starter;
  let heaviest = -1;
  for (const p of [0, 1]) {
    for (const t of hands[p]) {
      if (t.a + t.b > heaviest) {
        heaviest = t.a + t.b;
        starter = p;
      }
    }
  }
  return starter;
}

/** A fresh round: state + hands + boneyard. `starter` overrides the deal's natural leader. */
export function startRound(round, deck = shuffle(newDeck()), starter = null) {
  const { hands, boneyard } = deal(deck);
  const state = {
    board: [],
    left: null,
    right: null,
    seq: 0,
    turn: starter === null ? chooseStarter(hands) : starter,
    passes: 0,
    round,
    scores: [0, 0],
    over: false,
    roundResult: null,
    matchOver: false,
  };
  return { state, hands, boneyard };
}

export function playableIds(state, hand) {
  if (!hand || !hand.length) return [];
  if (state.board.length === 0) return hand.map((t) => t.id);
  return hand
    .filter((t) => t.a === state.left || t.b === state.left || t.a === state.right || t.b === state.right)
    .map((t) => t.id);
}

export function canDraw(state, hand, boneyard) {
  return !state.over && state.board.length > 0 && playableIds(state, hand).length === 0 && boneyard.length > 0;
}

export function canPass(state, hand, boneyard) {
  return !state.over && state.board.length > 0 && boneyard.length === 0 && playableIds(state, hand).length === 0;
}

function endRound(state, winner, pts, reason, scores) {
  const next = { ...state, over: true };
  const s = [scores[0], scores[1]];
  if (winner === 0 || winner === 1) s[winner] += pts;
  next.scores = s;
  next.roundResult = { winner, pts, reason };
  next.matchOver = s.some((v) => v >= TARGET_SCORE);
  return next;
}

/**
 * Play one tile on one end. Returns { state, hand } or { err }.
 * `p` is the acting seat; `state.scores` is carried through unchanged.
 */
export function play(state, hand, p, tileId, end) {
  if (state.over) return { err: 'Round is over' };
  if (p !== state.turn) return { err: 'Not your turn' };
  const idx = hand.findIndex((t) => t.id === tileId);
  if (idx < 0) return { err: 'Tile not in your hand' };
  const t = hand[idx];

  let disp;
  let place;
  if (state.board.length === 0) {
    disp = { id: t.id, a: t.a, b: t.b };
    place = 'right';
  } else {
    if (end !== 'left' && end !== 'right') return { err: 'Choose an end' };
    const target = end === 'left' ? state.left : state.right;
    if (t.a !== target && t.b !== target) return { err: `Tile must match ${target}` };
    const match = t.a === target ? t.a : t.b;
    const other = t.a === target ? t.b : t.a;
    disp = end === 'right' ? { id: t.id, a: match, b: other } : { id: t.id, a: other, b: match };
    place = end;
  }

  const placed = { ...disp, double: disp.a === disp.b, seq: state.seq + 1 };
  const empty = state.board.length === 0;
  const board = place === 'left' ? [placed, ...state.board] : [...state.board, placed];
  const next = {
    ...state,
    board,
    seq: state.seq + 1,
    left: place === 'left' || empty ? placed.a : state.left,
    right: place === 'right' ? placed.b : state.right,
    passes: 0,
  };
  const nextHand = hand.filter((_, i) => i !== idx);

  if (nextHand.length === 0) {
    // Dominoed. The opponent's hand is not visible here, so scoring is a
    // separate call: finalizeDomino(state, winner, opponentHand).
    return { state: { ...next, turn: 1 - p }, hand: nextHand, dominoed: true };
  }
  next.turn = 1 - p;
  return { state: next, hand: nextHand };
}

/** Score a completed hand: winner takes the pips left in the opponent's hand. */
export function finalizeDomino(state, winner, opponentHand) {
  return endRound(state, winner, pips(opponentHand), 'domino', state.scores);
}

/** Draw the top tile. Returns { hand, boneyard } or { err }. */
export function draw(state, hand, boneyard, p) {
  if (state.over) return { err: 'Round is over' };
  if (p !== state.turn) return { err: 'Not your turn' };
  if (state.board.length === 0) return { err: 'You must start the round' };
  if (playableIds(state, hand).length > 0) return { err: 'You have a playable tile — play it' };
  if (boneyard.length === 0) return { err: 'The boneyard is empty' };
  return { hand: [...hand, boneyard[0]], boneyard: boneyard.slice(1) };
}

/** Pass when stuck. Two passes in a row end the round as blocked. Returns { state } or { err }. */
export function pass(state, hand, boneyard, p, otherHand) {
  if (state.over) return { err: 'Round is over' };
  if (p !== state.turn) return { err: 'Not your turn' };
  if (state.board.length === 0) return { err: 'You must start the round' };
  if (playableIds(state, hand).length > 0) return { err: 'You have a playable tile — play it' };
  if (boneyard.length > 0) return { err: 'Draw from the boneyard first' };

  const passes = state.passes + 1;
  if (passes >= 2) {
    // Blocked. otherHand lets the caller score by pip difference.
    return { state: { ...state, passes }, blocked: true };
  }
  return { state: { ...state, passes, turn: 1 - p } };
}

/** Score a blocked round: lower pip count wins the difference; equal = no score. */
export function finalizeBlocked(state, handA, handB) {
  const a = pips(handA);
  const b = pips(handB);
  if (a === b) return endRound(state, -1, 0, 'blocked', state.scores);
  return endRound(state, a < b ? 0 : 1, Math.abs(a - b), 'blocked', state.scores);
}

/** Next round's leader: the previous round's winner, or seat 0 on a tie. */
export function nextStarter(state) {
  return state.roundResult && state.roundResult.winner >= 0 ? state.roundResult.winner : 0;
}
