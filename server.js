// Domino game server: WebSocket rooms keyed by a 6-digit code.
//
// All game rules live in game/rules.js — the same module the Firestore-backed
// client uses, so there is one implementation of the game. This file is only
// transport: the room registry, a per-seat view, and message validation.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as G from './public/game-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// The invite link is copied from the browser, so the page needs to know the
// addresses this machine is actually reachable on (localhost only works locally).
app.get('/api/info', (req, res) => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${PORT}`);
  res.json({ lan, port: Number(PORT) });
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** code -> room */
const rooms = new Map();

function emptyState() {
  return {
    board: [],
    left: null,
    right: null,
    seq: 0,
    turn: 0,
    passes: 0,
    round: 0,
    scores: [0, 0],
    over: false,
    roundResult: null,
    matchOver: false,
  };
}

function playableIds(room, p) {
  return G.playableIds(room.state, room.hands[p] || []);
}

function startRound(room, starterHint = null) {
  const r = G.startRound((room.round || 0) + 1, undefined, starterHint);
  room.state = r.state;
  room.hands = r.hands;
  room.boneyard = r.boneyard;
}

function doPlay(room, p, tileId, end) {
  const r = G.play(room.state, room.hands[p], p, tileId, end);
  if (r.err) return r;
  room.hands[p] = r.hand;
  room.state = r.state;
  if (r.dominoed) room.state = G.finalizeDomino(room.state, p, room.hands[1 - p]);
  return {};
}

function doDraw(room, p) {
  const r = G.draw(room.state, room.hands[p], room.boneyard, p);
  if (r.err) return r;
  room.hands[p] = r.hand;
  room.boneyard = r.boneyard;
  return {};
}

function doPass(room, p) {
  const r = G.pass(room.state, room.hands[p], room.boneyard, p);
  if (r.err) return r;
  room.state = r.blocked ? G.finalizeBlocked(r.state, room.hands[0], room.hands[1]) : r.state;
  return {};
}

function view(room, p) {
  const s = room.state;
  const hand = room.hands ? room.hands[p] : [];
  const playable = room.hands && !s.over && s.turn === p ? playableIds(room, p) : [];
  return {
    type: 'state',
    you: p,
    code: room.code,
    phase: room.phase,
    scores: s.scores,
    target: G.TARGET_SCORE,
    board: s.board,
    left: s.left,
    right: s.right,
    hand,
    counts: room.hands ? [room.hands[0].length, room.hands[1].length] : [0, 0],
    boneyard: room.boneyard ? room.boneyard.length : 0,
    turn: s.turn,
    over: s.over,
    roundResult: s.roundResult,
    matchOver: s.matchOver,
    round: s.round,
    playable,
    canDraw: !!room.hands && G.canDraw(s, hand, room.boneyard || []),
    canPass: !!room.hands && G.canPass(s, hand, room.boneyard || []),
    online: [!!room.socks[0], !!room.socks[1]],
    rematch: room.rematch || [false, false],
  };
}

// ------------------------------------------------------------------ rooms / ws

function newCode() {
  let c;
  do {
    c = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(c));
  return c;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  for (const p of [0, 1]) {
    const ws = room.socks[p];
    if (ws && ws.readyState === 1) send(ws, view(room, p));
  }
}

function newRoom() {
  const code = newCode();
  const room = {
    code,
    phase: 'waiting',
    socks: [null, null],
    tokens: [crypto.randomUUID(), crypto.randomUUID()],
    hands: null,
    boneyard: [],
    state: emptyState(),
    rematch: [false, false],
  };
  rooms.set(code, room);
  setTimeout(() => {
    const r = rooms.get(code);
    if (r && !r.socks[0] && !r.socks[1]) rooms.delete(code);
  }, 30 * 60 * 1000);
  return room;
}

wss.on('connection', (ws) => {
  ws.ctx = { room: null, player: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Bad message' });
    }

    try {
      switch (msg.type) {
        case 'create': {
          const room = newRoom();
          room.socks[0] = ws;
          ws.ctx = { room, player: 0 };
          send(ws, { type: 'joined', code: room.code, player: 0, token: room.tokens[0] });
          broadcast(room);
          break;
        }
        case 'join': {
          const code = String(msg.code || '').trim();
          const room = rooms.get(code);
          if (!room) return send(ws, { type: 'error', message: 'No game with that code — ask the host for a fresh one' });
          if (room.socks[1]) return send(ws, { type: 'error', message: 'That game is already full (two players)' });
          room.socks[1] = ws;
          ws.ctx = { room, player: 1 };
          send(ws, { type: 'joined', code, player: 1, token: room.tokens[1] });
          if (room.phase === 'waiting') {
            room.phase = 'playing';
            startRound(room);
          }
          broadcast(room);
          break;
        }
        case 'rejoin': {
          const room = rooms.get(String(msg.code || '').trim());
          if (!room) return send(ws, { type: 'error', message: 'That game has expired — start a new one' });
          const p = room.tokens.indexOf(msg.token);
          if (p < 0) return send(ws, { type: 'error', message: 'Unknown player — join with the code instead' });
          room.socks[p] = ws;
          ws.ctx = { room, player: p };
          send(ws, { type: 'joined', code: room.code, player: p, token: room.tokens[p] });
          broadcast(room);
          break;
        }
        case 'play': {
          const { room, player } = ws.ctx;
          if (!room || player === null) return;
          if (room.phase !== 'playing') return send(ws, { type: 'error', message: 'Game not started' });
          const r = doPlay(room, player, msg.tile, msg.end);
          if (r.err) send(ws, { type: 'error', message: r.err });
          broadcast(room);
          break;
        }
        case 'draw': {
          const { room, player } = ws.ctx;
          if (!room || player === null) return;
          const r = doDraw(room, player);
          if (r.err) send(ws, { type: 'error', message: r.err });
          broadcast(room);
          break;
        }
        case 'pass': {
          const { room, player } = ws.ctx;
          if (!room || player === null) return;
          const r = doPass(room, player);
          if (r.err) send(ws, { type: 'error', message: r.err });
          broadcast(room);
          break;
        }
        case 'rematch': {
          const { room, player } = ws.ctx;
          if (!room || player === null || !room.state.over) return;
          room.rematch[player] = true;
          if (room.rematch[0] && room.rematch[1]) {
            room.rematch = [false, false];
            startRound(room, G.nextStarter(room.state));
          }
          broadcast(room);
          break;
        }
        default:
          send(ws, { type: 'error', message: 'Unknown message type' });
      }
    } catch (e) {
      console.error('handler error', e);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });

  ws.on('close', () => {
    const { room, player } = ws.ctx;
    if (!room || player === null) return;
    if (room.socks[player] === ws) room.socks[player] = null;
    broadcast(room);
  });
});

server.listen(PORT, () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`Domino game running on http://localhost:${PORT}`);
  for (const n of nets) console.log(`  on your network:  http://${n.address}:${PORT}`);
});
