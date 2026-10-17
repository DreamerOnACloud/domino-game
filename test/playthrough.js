// Headless playthrough: drives two real WebSocket clients through full games
// and asserts the server enforces rules and scores correctly.
import WebSocket from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
const GAMES = Number(process.env.GAMES || 5);

function client() {
  const ws = new WebSocket(URL);
  const c = {
    ws,
    state: null,
    errors: [],
    joined: null,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, timeout = 5000) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting')), timeout);
        const check = () => {
          let ok = false;
          try { ok = pred(c); } catch {}
          if (ok) { clearTimeout(t); ws.off('message', check); res(); }
        };
        ws.on('message', check);
        check();
      }),
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state') c.state = m;
    if (m.type === 'joined') c.joined = m;
    if (m.type === 'error') c.errors.push(m.message);
  });
  return c;
}

const open = (c) => new Promise((res) => c.ws.on('open', res));

function pickMove(s) {
  if (s.playable.length === 0) {
    if (s.canDraw) return { type: 'draw' };
    if (s.canPass) return { type: 'pass' };
    return null;
  }
  const id = s.playable[0];
  const tile = s.hand.find((t) => t.id === id);
  if (s.board.length === 0) return { type: 'play', tile: id, end: null };
  const fitsLeft = tile.a === s.left || tile.b === s.left;
  const fitsRight = tile.a === s.right || tile.b === s.right;
  const end = fitsRight ? 'right' : 'left';
  if (!fitsLeft && !fitsRight) throw new Error('server said playable but tile matches neither end');
  return { type: 'play', tile: id, end };
}

async function playGame(g) {
  const a = client();
  const b = client();
  await Promise.all([open(a), open(b)]);

  a.send({ type: 'create' });
  await a.wait((c) => c.state && c.state.phase === 'waiting');
  const code = a.state.code;
  if (!/^\d{6}$/.test(code)) throw new Error('bad code: ' + code);

  b.send({ type: 'join', code });
  await Promise.all([a.wait((c) => c.state.phase === 'playing'), b.wait((c) => c.state.phase === 'playing')]);

  const me = { 0: a, 1: b };
  const seen = { a: new Set(), b: new Set() };

  // sanity: 7 + 7 tiles, 14 in boneyard, no duplicate ids across hands
  const ids = [...a.state.hand, ...b.state.hand].map((t) => t.id);
  if (ids.length !== 14 || new Set(ids).size !== 14) throw new Error('duplicate tiles dealt');
  if (a.state.boneyard !== 14) throw new Error('boneyard != 14');
  const overlap = a.state.hand.filter((t) => b.state.hand.some((u) => u.id === t.id));
  if (overlap.length) throw new Error('hands overlap');

  let guard = 0;
  const sig = (s) => s ? `${s.board.length}|${s.hand.length}|${s.turn}|${s.over}|${s.boneyard}` : '';
  while (guard++ < 400) {
    const cur = me[a.state.turn];
    const s = cur.state;
    if (s.over) break;
    if (s.turn !== s.you) throw new Error('turn desync');
    const mv = pickMove(s);
    if (!mv) throw new Error('no legal move and no draw/pass offered');
    const before = { a: sig(a.state), b: sig(b.state) };
    cur.send(mv);
    await Promise.all([
      a.wait((c) => sig(c.state) !== before.a),
      b.wait((c) => sig(c.state) !== before.b),
    ]);
    if (a.state.turn !== b.state.turn && !a.state.over) throw new Error('clients disagree on turn');
  }

  if (!a.state.over) throw new Error('game did not finish');
  if (a.state.scores.join() !== b.state.scores.join()) throw new Error('score desync');
  if (!/^\d{6}$/.test(a.state.code)) throw new Error('code lost');

  // consistency: board is a linear chain left -> right
  const bd = a.state.board;
  for (let i = 1; i < bd.length; i++) {
    if (bd[i - 1].b !== bd[i].a) {
      throw new Error(`board chain broken at ${i}: ${bd[i - 1].b} vs ${bd[i].a}`);
    }
  }
  if (bd.length) {
    if (bd[0].a !== a.state.left) throw new Error('left end mismatch');
    if (bd[bd.length - 1].b !== a.state.right) throw new Error('right end mismatch');
    const seqs = bd.map((t) => t.seq);
    if (new Set(seqs).size !== seqs.length) throw new Error('duplicate seq on board');
  }

  const errs = [...a.errors, ...b.errors].filter((e) => !/expired|full/.test(e));
  return {
    code,
    tiles: bd.length,
    moves: guard,
    scores: a.state.scores,
    result: a.state.roundResult,
    matchOver: a.state.matchOver,
    strayErrors: errs,
  };
}

const results = [];
for (let i = 0; i < GAMES; i++) {
  try {
    results.push({ ok: true, ...(await playGame(i)) });
  } catch (e) {
    results.push({ ok: false, error: e.message });
  }
}
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${GAMES - failed}/${GAMES} games completed cleanly`);
process.exit(failed ? 1 : 0);
