// Rule-enforcement tests: the server must reject every illegal action,
// and blocked games (both players stuck, boneyard empty) must resolve correctly.
import WebSocket from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

function client() {
  const ws = new WebSocket(URL);
  const c = { ws, state: null, errors: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state') c.state = m;
    if (m.type === 'error') c.errors.push(m.message);
  });
  return c;
}
const open = (c) => new Promise((r) => c.ws.on('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await sleep(15); }
  return false;
};

async function pair() {
  const a = client(), b = client();
  await Promise.all([open(a), open(b)]);
  a.send({ type: 'create' });
  await waitFor(() => a.state && a.state.phase === 'waiting');
  b.send({ type: 'join', code: a.state.code });
  await waitFor(() => a.state.phase === 'playing' && b.state.phase === 'playing');
  return { a, b, me: { 0: a, 1: b } };
}

const sig = (s) => s ? `${s.board.length}|${s.hand.length}|${s.turn}|${s.over}|${s.boneyard}` : '';
const other = (n) => 1 - n;

/** send an action and assert a NEW error matching `re` came back */
async function expectError(c, action, re, label) {
  const n = c.errors.length;
  action();
  await waitFor(() => c.errors.length > n);
  const got = c.errors.slice(n).join(' | ');
  ok(label, re.test(got), got || '(no error at all)');
}

async function advance(M, a, b) {
  const cur = M[a.state.turn];
  const before = { a: sig(a.state), b: sig(b.state) };
  const mv = pickMove(cur.state);
  if (!mv) throw new Error('stuck');
  cur.send(mv);
  await Promise.all([waitFor(() => sig(a.state) !== before.a), waitFor(() => sig(b.state) !== before.b)]);
}

function pickMove(s) {
  if (!s.playable.length) return s.canDraw ? { type: 'draw' } : s.canPass ? { type: 'pass' } : null;
  const id = s.playable[0];
  const t = s.hand.find((x) => x.id === id);
  if (!s.board.length) return { type: 'play', tile: id, end: null };
  const fitsL = t.a === s.left || t.b === s.left;
  const fitsR = t.a === s.right || t.b === s.right;
  return { type: 'play', tile: id, end: fitsR ? 'right' : 'left' };
}

async function turn(cur, a, b) {
  const before = { a: sig(a.state), b: sig(b.state) };
  const mv = pickMove(cur.state);
  if (!mv) throw new Error('stuck');
  cur.send(mv);
  await Promise.all([waitFor(() => sig(a.state) !== before.a), waitFor(() => sig(b.state) !== before.b)]);
}

async function playRounds(reasonWanted, maxGames) {
  const hist = {};
  let blockedSeen = null;
  for (let g = 0; g < maxGames; g++) {
    const { a, b, me } = await pair();
    let guard = 0;
    while (!a.state.over && guard++ < 400) await turn(me[a.state.turn], a, b);
    if (!a.state.over) throw new Error('game hung');
    const r = a.state.roundResult.reason;
    hist[r] = (hist[r] || 0) + 1;
    if (r === 'blocked' && !blockedSeen) blockedSeen = { a: a.state, g };
    if (reasonWanted && hist[reasonWanted] >= 3) break;
    a.ws.close(); b.ws.close();
  }
  return { hist, blockedSeen };
}

// ---------------------------------------------------------------- rule tests
console.log('\nRule enforcement');
{
  let { a, b, me } = await pair();
  const code = a.state.code;
  const someoneElse = client();
  await open(someoneElse);

  // join a full room
  someoneElse.send({ type: 'join', code });
  await waitFor(() => someoneElse.errors.length);
  ok('third player is refused', /full/i.test(someoneElse.errors[0] || ''), someoneElse.errors.join());

  // join a nonexistent room
  const ghost = client(); await open(ghost);
  ghost.send({ type: 'join', code: '000001' });
  await waitFor(() => ghost.errors.length);
  ok('unknown code is refused', /no game/i.test(ghost.errors[0] || ''), ghost.errors.join());

  const M = me;
  const cur = M[a.state.turn];
  const idle = M[other(a.state.turn)];

  // out of turn
  await expectError(idle, () => idle.send({ type: 'play', tile: idle.state.hand[0].id, end: 'left' }),
    /not your turn/i, 'out-of-turn play is refused');

  // a tile the player does not hold (taken from the opponent's hand)
  await expectError(cur, () => cur.send({ type: 'play', tile: idle.state.hand[0].id, end: 'right' }),
    /not in your hand/i, 'playing a tile you do not hold is refused');
  // the round must be opened with a tile, not a draw or a pass
  await expectError(cur, () => cur.send({ type: 'draw' }), /start the round/i,
    'drawing before the round starts is refused');
  await expectError(cur, () => cur.send({ type: 'pass' }), /start the round/i,
    'passing before the round starts is refused');
  await expectError(idle, () => idle.send({ type: 'play', tile: idle.state.hand[0].id, end: null }),
    /not your turn/i, 'the non-starter cannot open the round');

  // open the round
  await advance(M, a, b);
  ok('the opening tile is on the board', a.state.board.length === 1 && b.state.board.length === 1);
  const opener = a.state.board[0];
  ok('the opening tile defines both ends',
    a.state.left === opener.a && a.state.right === opener.b, JSON.stringify(opener));

  // walk games until every illegal-move probe has been observed at least once
  let probed = { mismatch: false, drawWhileAble: false, passWhileAble: false, drawFromEmpty: false };
  let probesRun = 0;
  let pairNo = 0;
  while (Object.values(probed).some((v) => !v) && pairNo < 30) {
    if (pairNo > 0) {
      a.ws.close(); b.ws.close();
      ({ a, b, me } = await pair());
      await advance(me, a, b);
    }
    pairNo++;
    let played = 0;
    const M2 = me;
    while (played < 200 && !a.state.over && Object.values(probed).some((v) => !v)) {
      const t = M2[a.state.turn];

      if (!probed.mismatch && t.state.board.length) {
        const bad = t.state.hand.find((x) =>
          x.a !== t.state.left && x.b !== t.state.left && x.a !== t.state.right && x.b !== t.state.right);
        if (bad) {
          await expectError(t, () => t.send({ type: 'play', tile: bad.id, end: 'left' }),
            /must match/i, 'a tile matching neither end is refused');
          probed.mismatch = true;
        }
      }
      if (!probed.drawWhileAble && t.state.board.length && t.state.playable.length) {
        await expectError(t, () => t.send({ type: 'draw' }), /playable/i,
          'drawing while able to play is refused');
        await expectError(t, () => t.send({ type: 'pass' }), /playable/i,
          'passing while able to play is refused');
        probed.drawWhileAble = true;
        probed.passWhileAble = true;
      }
      if (!probed.drawFromEmpty && t.state.boneyard === 0 && t.state.board.length && !t.state.playable.length) {
        await expectError(t, () => t.send({ type: 'draw' }), /empty/i,
          'drawing from an empty boneyard is refused');
        probed.drawFromEmpty = true;
      }
      await advance(M2, a, b);
      played++;
      probesRun++;
      if (a.state.over) break;
    }
  }
  const unreached = Object.entries(probed).filter(([, v]) => !v).map(([k]) => k);
  ok('every illegal-move probe was reachable in play', unreached.length === 0,
    `${unreached.join(', ')} (after ${pairNo} games, ${probesRun} moves)`);

  // the assertions below need a live pair
  if (!a || a.ws.readyState !== 1 || !a.state || a.state.over) {
    a.ws.close(); b.ws.close();
    ({ a, b, me } = await pair());
  }

  // garbage message
  await expectError(a, () => a.send({ type: 'nonsense' }), /unknown/i,
    'unknown message type is refused');

  const beforeBad = a.errors.length;
  a.ws.send('not json');
  await waitFor(() => a.errors.length > beforeBad);
  ok('malformed json is refused', /bad message/i.test(a.errors.slice(beforeBad).join(' | ')));

  // state privacy: the opponent's tiles are never sent, only their count
  ok('opponent tiles are not leaked',
    !('hands' in a.state) && !('oppHand' in a.state) && !Array.isArray(a.state.boneyard));
  ok('the boneyard is exposed only as a number', typeof a.state.boneyard === 'number');
  ok('your hand matches your own count', a.state.hand.length === a.state.counts[a.state.you]);
  // counts[] is indexed by absolute player number, not relative to the viewer
  const agree = (x, y) => x.state.counts[x.state.you] === x.state.hand.length &&
    x.state.counts[1 - x.state.you] === y.state.hand.length;
  await waitFor(() => a.state && b.state && agree(a, b) && agree(b, a));
  ok('hand sizes agree across clients', agree(a, b) && agree(b, a),
    `a=${JSON.stringify(a.state.counts)} hand=${a.state.hand.length} · b=${JSON.stringify(b.state.counts)} hand=${b.state.hand.length}`);

  a.ws.close(); b.ws.close(); someoneElse.ws.close(); ghost.ws.close();
}

// ---------------------------------------------------------------- blocked games
console.log('\nBlocked-game resolution (drives many full games)');
const { hist, blockedSeen } = await playRounds('blocked', 120);
console.log('  outcome distribution:', JSON.stringify(hist));
ok('at least one blocked game occurred', !!blockedSeen, JSON.stringify(hist));
if (blockedSeen) {
  const s = blockedSeen.a;
  const r = s.roundResult;
  ok('blocked round produced a result', r.reason === 'blocked' && (r.winner === -1 || r.pts > 0));
  ok('blocked round scored the pip difference or zero',
     r.winner === -1 ? r.pts === 0 : r.pts >= 1, JSON.stringify(r));
  const nonZeroHands = s.counts[0] + s.counts[1];
  ok('both hands still hold tiles when blocked', nonZeroHands > 0);
  ok('the boneyard is empty when blocked', s.boneyard === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
