const socket = io();
const $ = id => document.getElementById(id);
const entry = $("entry"), lobby = $("lobby"), game = $("game");
let myName = "플레이어", mySeat = null, currentRoom = null, roomState = null, countdown = null, localRevealAt = null, latestHand = null;

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  setTimeout(() => $("toast").classList.add("hidden"), 2600);
}
function showOnly(section) {
  [entry, lobby, game].forEach(s => s.classList.add("hidden"));
  section.classList.remove("hidden");
}
function cardNode(card) {
  const el = document.createElement("div");
  el.className = "card" + (["♥", "♦"].includes(card.suit) ? " red" : "");
  const top = document.createElement("div"); top.className = "rank"; top.textContent = card.rank;
  const suit = document.createElement("div"); suit.className = "suit"; suit.textContent = card.suit;
  const bottom = document.createElement("div"); bottom.className = "rank bottom"; bottom.textContent = card.rank;
  el.append(top, suit, bottom);
  return el;
}
function renderCards(container, cards) {
  container.replaceChildren();
  cards.forEach(c => container.appendChild(cardNode(c)));
}
function renderBacks(container, count=7) {
  container.replaceChildren();
  for (let i=0;i<count;i++) {
    const el=document.createElement("div"); el.className="card back"; el.textContent="✦"; container.appendChild(el);
  }
}
function beginCountdown(revealAt, seconds=30) {
  localRevealAt = revealAt || Date.now() + seconds*1000;
  if (countdown) clearInterval(countdown);
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((localRevealAt - Date.now()) / 1000));
    $("timer").textContent = remaining;
    if (remaining <= 0 && countdown) { clearInterval(countdown); countdown = null; }
  };
  tick();
  countdown = setInterval(tick, 200);
}
function updatePlayers(state) {
  $("players").replaceChildren();
  state.players.forEach(p => {
    const div = document.createElement("div"); div.className = "player";
    const name = document.createElement("strong"); name.textContent = `${p.seat}번 · ${p.name}`;
    const status = document.createElement("span"); status.textContent = p.connected ? "접속 중" : "연결 끊김";
    div.append(name,status); $("players").appendChild(div);
  });
  if (state.players.length < 2) $("lobbyMessage").textContent = "친구가 입장하기를 기다리는 중...";
}
function showResult(data) {
  if (countdown) clearInterval(countdown);
  countdown = null;
  $("timer").textContent = "공개";
  $("gameTitle").textContent = "승부 결과";
  $("gameMessage").textContent = "두 사람의 카드가 모두 공개됐어요.";
  const mine = data.players.find(p => p.seat === mySeat);
  const opponent = data.players.find(p => p.seat !== mySeat);
  if (mine) renderCards($("myCards"), mine.cards);
  $("opponentArea").classList.remove("hidden");
  $("opponentTitle").textContent = `${opponent.name}의 카드 · ${opponent.handName}`;
  renderCards($("opponentCards"), opponent.cards);
  const result = $("result"); result.classList.remove("hidden");
  const winner = data.winnerSeat === null ? "무승부!" : (data.winnerSeat === mySeat ? "내 승리!" : `${opponent.name} 승리!`);
  result.replaceChildren();
  const strong = document.createElement("strong"); strong.textContent = winner;
  const p1 = document.createElement("p"); p1.textContent = `내 족보: ${mine.handName}`;
  const p2 = document.createElement("p"); p2.textContent = `${opponent.name}의 족보: ${opponent.handName}`;
  result.append(strong,p1,p2);
  $("againBtn").classList.remove("hidden");
}
function enterGame() {
  showOnly(game);
  $("opponentArea").classList.add("hidden");
  $("result").classList.add("hidden");
  $("againBtn").classList.add("hidden");
}
function requestCreate() {
  myName = $("playerName").value.trim() || "플레이어";
  socket.emit("create-room", { name: myName }, response => {
    if (!response?.ok) return toast("방을 만들지 못했습니다.");
    currentRoom = response.code; mySeat = response.seat;
    $("roomCodeLabel").textContent = currentRoom;
    showOnly(lobby);
    toast("방을 만들었습니다. 코드를 친구에게 보내세요.");
  });
}
function requestJoin() {
  myName = $("playerName").value.trim() || "플레이어";
  const code = $("roomCode").value.trim().toUpperCase();
  if (!code) return toast("친구의 방 코드를 입력해 주세요.");
  socket.emit("join-room", { code, name: myName }, response => {
    if (!response?.ok) return toast(response?.error || "방에 입장하지 못했습니다.");
    currentRoom = response.code; mySeat = response.seat;
    $("roomCodeLabel").textContent = currentRoom;
    enterGame();
  });
}
$("createBtn").addEventListener("click", requestCreate);
$("joinBtn").addEventListener("click", requestJoin);
$("roomCode").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0,5); });
$("copyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentRoom); toast("방 코드가 복사됐습니다."); }
  catch { toast(`친구에게 보낼 방 코드: ${currentRoom}`); }
});
$("againBtn").addEventListener("click", () => {
  socket.emit("play-again", {}, response => {
    if (!response?.ok) return toast(response?.error || "다시 시작할 수 없습니다.");
    $("againBtn").classList.add("hidden");
    $("result").classList.add("hidden");
    $("opponentArea").classList.add("hidden");
    $("gameTitle").textContent = "내 카드";
    $("gameMessage").textContent = "내 카드 7장을 확인하세요. 30초 후 자동으로 공개됩니다.";
    renderBacks($("myCards"));
  });
});

socket.on("room-state", state => {
  roomState = state;
  if (state.code) {
    currentRoom = state.code;
    $("roomCodeLabel").textContent = state.code;
    updatePlayers(state);
  }
  if (state.status === "waiting" && !game.classList.contains("hidden")) showOnly(lobby);
});
socket.on("private-hand", data => {
  latestHand = data.cards;
  enterGame();
  $("roundNum").textContent = data.round;
  $("gameTitle").textContent = "내 카드";
  $("gameMessage").textContent = "내 카드 7장을 확인하세요. 30초 후 자동으로 공개됩니다.";
  $("opponentTitle").textContent = "상대방 카드";
  renderCards($("myCards"), data.cards);
  renderBacks($("opponentCards"));
  $("timer").textContent = "30";
  $("againBtn").classList.add("hidden");
});
socket.on("round-started", data => {
  enterGame();
  beginCountdown(data.revealAt, data.seconds);
});
socket.on("round-result", showResult);
socket.on("connect_error", () => toast("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요."));
socket.on("disconnect", () => toast("서버 연결이 끊겼습니다. 새로고침 후 다시 접속해 주세요."));
