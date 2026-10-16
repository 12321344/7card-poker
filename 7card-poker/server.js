const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const REVEAL_SECONDS = 30;
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [
  { name: "2", value: 2 }, { name: "3", value: 3 }, { name: "4", value: 4 },
  { name: "5", value: 5 }, { name: "6", value: 6 }, { name: "7", value: 7 },
  { name: "8", value: 8 }, { name: "9", value: 9 }, { name: "10", value: 10 },
  { name: "J", value: 11 }, { name: "Q", value: 12 }, { name: "K", value: 13 },
  { name: "A", value: 14 }
];

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const socketRoom = new Map();

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), b => alphabet[b % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) {
    deck.push({ suit, rank: rank.name, value: rank.value, id: `${rank.name}${suit}` });
  }
  // Fisher-Yates using crypto-backed random integers.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function publicRoomState(room) {
  return {
    code: room.code,
    players: room.players.map((p, i) => ({ seat: i + 1, name: p.name, connected: p.connected })),
    status: room.status,
    revealAt: room.revealAt,
    round: room.round
  };
}
function emitRoomState(room) {
  io.to(room.code).emit("room-state", publicRoomState(room));
}
function cleanupSocketRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  if (!room) return;
  const player = room.players.find(p => p.id === socket.id);
  if (player) player.connected = false;
  emitRoomState(room);
  // Keep the room briefly so a temporary reconnect does not instantly destroy it.
  setTimeout(() => {
    const current = rooms.get(code);
    if (current && current.players.every(p => !p.connected)) {
      if (current.timer) clearTimeout(current.timer);
      rooms.delete(code);
    }
  }, 60_000).unref?.();
}
function getPlayer(socket) {
  const code = socketRoom.get(socket.id);
  const room = code && rooms.get(code);
  const player = room && room.players.find(p => p.id === socket.id);
  return { code, room, player };
}
function safeName(input) {
  const name = String(input || "").trim().replace(/[<>]/g, "").slice(0, 18);
  return name || "플레이어";
}

function combinations(cards, k) {
  const out = [];
  function walk(start, chosen) {
    if (chosen.length === k) { out.push(chosen); return; }
    for (let i = start; i <= cards.length - (k - chosen.length); i++) {
      walk(i + 1, chosen.concat(cards[i]));
    }
  }
  walk(0, []);
  return out;
}
function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1); // Ace can be low in A-2-3-4-5.
  for (let i = 0; i <= unique.length - 5; i++) {
    const run = unique.slice(i, i + 5);
    if (run[0] - run[4] === 4 && new Set(run).size === 5) return run[0] === 1 ? 5 : run[0];
  }
  return 0;
}
function evaluateFive(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const counts = new Map();
  values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.entries()].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const sh = straightHigh(values);
  if (flush && sh) return { rank: 8, name: sh === 14 ? "로열 플러시" : "스트레이트 플러시", tie: [sh] };
  if (groups[0].count === 4) return { rank: 7, name: "포카드", tie: [groups[0].value, groups[1].value] };
  if (groups[0].count === 3 && groups[1].count === 2) return { rank: 6, name: "풀하우스", tie: [groups[0].value, groups[1].value] };
  if (flush) return { rank: 5, name: "플러시", tie: values };
  if (sh) return { rank: 4, name: "스트레이트", tie: [sh] };
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { rank: 3, name: "트리플", tie: [groups[0].value, ...kickers] };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter(g => g.count === 2).map(g => g.value).sort((a, b) => b - a);
    const kicker = groups.find(g => g.count === 1).value;
    return { rank: 2, name: "투페어", tie: [...pairs, kicker] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.value).sort((a, b) => b - a);
    return { rank: 1, name: "원페어", tie: [groups[0].value, ...kickers] };
  }
  return { rank: 0, name: "하이카드", tie: values };
}
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
    const av = a.tie[i] || 0, bv = b.tie[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
function bestOfSeven(cards) {
  let best = null;
  for (const five of combinations(cards, 5)) {
    const value = evaluateFive(five);
    if (!best || compareHands(value, best.value) > 0) best = { value, cards: five };
  }
  return best;
}
function startRound(room) {
  if (room.players.length !== 2 || room.players.some(p => !p.connected)) return;
  if (room.timer) clearTimeout(room.timer);
  const deck = makeDeck();
  room.round += 1;
  room.hands = [deck.slice(0, 7), deck.slice(7, 14)];
  room.status = "playing";
  room.revealAt = Date.now() + REVEAL_SECONDS * 1000;
  room.result = null;
  room.players.forEach((p, index) => {
    io.to(p.id).emit("private-hand", { cards: room.hands[index], round: room.round });
  });
  emitRoomState(room);
  io.to(room.code).emit("round-started", { revealAt: room.revealAt, seconds: REVEAL_SECONDS, round: room.round });
  room.timer = setTimeout(() => revealRound(room), REVEAL_SECONDS * 1000);
}
function revealRound(room) {
  if (room.status !== "playing" || !room.hands) return;
  const best = room.hands.map(bestOfSeven);
  const comparison = compareHands(best[0].value, best[1].value);
  let winner = comparison > 0 ? 0 : comparison < 0 ? 1 : -1;
  room.status = "revealed";
  room.revealAt = null;
  room.result = {
    winnerSeat: winner === -1 ? null : winner + 1,
    message: winner === -1 ? "무승부!" : `${room.players[winner].name} 승리!`,
    players: room.players.map((p, i) => ({
      seat: i + 1,
      name: p.name,
      cards: room.hands[i],
      handName: best[i].value.name,
      bestFive: best[i].cards,
      tie: best[i].value.tie
    }))
  };
  io.to(room.code).emit("round-result", room.result);
  emitRoomState(room);
}

io.on("connection", socket => {
  socket.on("create-room", ({ name } = {}, callback) => {
    if (socketRoom.has(socket.id)) cleanupSocketRoom(socket);
    const code = makeRoomCode();
    const room = { code, players: [{ id: socket.id, name: safeName(name), connected: true }], status: "waiting", revealAt: null, round: 0, hands: null, result: null, timer: null };
    rooms.set(code, room);
    socket.join(code);
    socketRoom.set(socket.id, code);
    if (typeof callback === "function") callback({ ok: true, code, seat: 1 });
    emitRoomState(room);
  });

  socket.on("join-room", ({ code, name } = {}, callback) => {
    const normalized = String(code || "").trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) return typeof callback === "function" && callback({ ok: false, error: "방 코드를 찾을 수 없습니다." });
    if (room.players.length >= 2) return typeof callback === "function" && callback({ ok: false, error: "방이 가득 찼습니다." });
    if (socketRoom.has(socket.id)) cleanupSocketRoom(socket);
    room.players.push({ id: socket.id, name: safeName(name), connected: true });
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    if (typeof callback === "function") callback({ ok: true, code: room.code, seat: 2 });
    emitRoomState(room);
    startRound(room);
  });

  socket.on("play-again", (_payload, callback) => {
    const { room } = getPlayer(socket);
    if (!room) return typeof callback === "function" && callback({ ok: false, error: "먼저 방에 입장해 주세요." });
    if (room.players.length !== 2 || room.players.some(p => !p.connected)) {
      return typeof callback === "function" && callback({ ok: false, error: "두 플레이어가 모두 접속해야 합니다." });
    }
    if (room.status === "playing") return typeof callback === "function" && callback({ ok: false, error: "현재 게임이 진행 중입니다." });
    if (typeof callback === "function") callback({ ok: true });
    startRound(room);
  });

  socket.on("disconnect", () => cleanupSocketRoom(socket));
});

server.listen(PORT, () => console.log(`7-card poker server listening on ${PORT}`));
