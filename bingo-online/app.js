/* Bingo Friends (5x5 BINGO, 7x7 FRIENDS, 10x10 BINGO CHIPS; Diwali, Christmas, Cricket, Halloween and Space themes) — live multiplayer over Firebase Realtime Database.
   Data: rooms/{CODE} = { hostKey, status, round, order[], skips, createdAt,
                          players: { pid: {name, joinedAt, round, board[], bingoAt, bingoRound} },
                          calls:   { r{round}: { n{num}: {n, by, at} } } } */

// Lines (rows, columns, two diagonals) for a 5x5 or 10x10 grid.
const LINE_CACHE = {};
function linesFor(n) {
  if (LINE_CACHE[n]) return LINE_CACHE[n];
  const idx = [...Array(n).keys()], L = [];
  idx.forEach(r => L.push(idx.map(c => r * n + c)));
  idx.forEach(c => L.push(idx.map(r => r * n + c)));
  L.push(idx.map(i => i * n + i), idx.map(i => i * n + (n - 1 - i)));
  return (LINE_CACHE[n] = L);
}
const WORDS = { 5: 'BINGO', 7: 'FRIENDS', 10: 'BINGOCHIPS' };
const CALL_LABEL = { 5: 'BINGO', 7: 'FRIENDS', 10: 'BINGO CHIPS' };
const SIZES = [5, 7, 10];
const sizeOf = v => SIZES.includes(v) ? v : 5;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 15;

const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

// Each browser gets its own player id, kept across reloads.
let pkey = store.get('bingo.pid');
if (!pkey) {
  pkey = 'p' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
  store.set('bingo.pid', pkey);
}

let rdb = null, TS = null;
let code = null, game = null, players = {}, calls = [];
let roomRef = null, lastRoomKey = '', lastCallKey = '';
let chatQuery = null, chatLoaded = false, chatOpen = false, unread = 0, lastSent = 0;
let draft = shuffled(5), fillMode = false, nextFill = 0;
let busy = false, view = 'home';

function shuffled(n) {
  const a = Array.from({length: n * n}, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const sideOf = board => Math.round(Math.sqrt(board.length));
const linesDone = (board, called) => Array.isArray(board) && board.length >= 25 ? linesFor(sideOf(board)).filter(l => l.every(i => called.has(board[i]))) : [];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const room = c => rdb.ref('rooms/' + c);

function show(v) {
  view = v;
  ['home','lobby','game'].forEach(x => $(x).hidden = x !== v);
}

/* ---------- derived game state ---------- */
function round() { return game?.round || 1; }
function N() { return sizeOf(game?.size); }
function WORD() { return WORDS[N()]; }
const fitsMode = b => Array.isArray(b) && b.length === N() * N();
function me() { return players[pkey]; }
function myBoard() { const p = me(); return p && p.round === round() && fitsMode(p.board) ? p.board : null; }
function calledSet() { return new Set(calls.map(c => c.n)); }
function readyPlayers() {
  return Object.values(players).filter(p => p.round === round() && fitsMode(p.board)).sort((a, b) => a.joinedAt - b.joinedAt);
}
function turnKey() {
  const order = game?.order || [];
  if (!order.length) return null;
  return order[(calls.length + (game.skips || 0)) % order.length];
}
function winner() {
  const called = calledSet();
  const claims = Object.values(players)
    .filter(p => p.bingoRound === round() && p.round === round() && p.bingoAt && (game.order || []).includes(p.key))
    .filter(p => fitsMode(p.board) && linesDone(p.board, called).length >= WORD().length)
    .sort((a, b) => a.bingoAt - b.bingoAt);
  return claims[0] || null;
}

/* ---------- rendering ---------- */
function renderGrid(el, board, opts) {
  const n = sideOf(board);
  el.style.setProperty('--n', n);
  el.classList.toggle('ten', n === 10);
  el.classList.toggle('seven', n === 7);
  el.innerHTML = '';
  board.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'cell';
    b.id = el.id + '-' + i;
    if (n == null) { b.classList.add('empty'); b.textContent = '·'; b.setAttribute('aria-label', 'Empty box'); }
    else { b.textContent = n; b.setAttribute('aria-label', 'Number ' + n + (opts.hit?.has(n) ? ', struck' : '')); }
    if (opts.hit?.has(n)) b.classList.add('hit');
    if (opts.last === n && n != null) b.classList.add('last');
    const can = opts.canTap?.(n, i);
    if (can) b.classList.add('tap'); else b.tabIndex = -1;
    b.addEventListener('click', () => can && opts.onTap(n, i));
    el.appendChild(b);
  });
}

function playerList(el, mode) {
  const called = calledSet();
  const tk = turnKey();
  const list = mode === 'game'
    ? (game.order || []).map(k => players[k]).filter(Boolean)
    : Object.values(players).filter(p => p.round === round() || p.key === game?.hostKey || p.key === pkey).sort((a, b) => a.joinedAt - b.joinedAt);
  el.innerHTML = list.map(p => {
    const ready = p.round === round() && fitsMode(p.board);
    const tags = [p.key === game.hostKey ? 'host' : '', p.key === pkey ? 'you' : ''].filter(Boolean).join(' · ');
    let right = '';
    if (mode === 'game') {
      const w = WORD(), n = Math.min(linesDone(p.board, called).length, w.length);
      right = `<span class="score"><b>${w.slice(0, n)}</b>${w.slice(n)}</span>`;
    }
    const dot = mode === 'game' ? (p.key === tk ? 'on' : '') : (ready ? 'on' : '');
    return `<li><span class="dot ${dot}"></span><span class="name">${esc(p.name)}${mode === 'game' && p.key === tk ? ' <span class="turn">· calling</span>' : ''}</span>${tags ? `<span class="tag">${tags}</span>` : ''}${right}</li>`;
  }).join('') || '<li class="tag">Nobody here yet</li>';
}

function drawLines(svg, done, n) {
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.classList.toggle('ten', n === 10);
  svg.classList.toggle('seven', n === 7);
  svg.innerHTML = done.map(l => {
    const a = l[0], z = l[l.length - 1];
    const ax = a % n + .5, ay = Math.floor(a / n) + .5, zx = z % n + .5, zy = Math.floor(z / n) + .5;
    const dx = (zx - ax) * .1, dy = (zy - ay) * .1;
    return `<line x1="${ax - dx}" y1="${ay - dy}" x2="${zx + dx}" y2="${zy + dy}"/>`;
  }).join('');
}

function render() {
  if (!code || !game) return;
  const isHost = game.hostKey === pkey;

  if (game.status === 'lobby') {
    show('lobby');
    $('win').hidden = true;
    $('lobbyCode').textContent = code;
    playerList($('lobbyPlayers'), 'lobby');
    if (draft.length !== N() * N()) { draft = shuffled(N()); fillMode = false; nextFill = 0; }
    ['mode5', 'mode7', 'mode10'].forEach(id => {
      const b = $(id), on = +b.dataset.size === N();
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.disabled = !isHost;
    });
    $('modeNote').textContent = isHost ? 'Changing the mode asks everyone to arrange a new grid.' : 'The host picks the mode.';
    renderThemePicker($('lobbyThemes'));
    $('themeNote').textContent = isHost ? 'Everyone in the room switches to the theme you pick.' : 'The host picks the theme.';
    const mine = myBoard();
    renderGrid($('setupGrid'), mine || draft, {
      canTap: (n) => !mine && fillMode && n == null,
      onTap: (n, i) => { draft[i] = ++nextFill; render(); $('setupGrid-' + i)?.focus(); }
    });
    $('arrangeControls').hidden = !!mine;
    $('readyControls').hidden = !mine;
    const ready = readyPlayers();
    const full = !mine && ready.length >= MAX_PLAYERS;
    $('readyBtn').disabled = draft.some(n => n == null) || full;
    $('startBtn').hidden = !isHost;
    $('startBtn').disabled = ready.length < 2 || !mine;
    let s;
    if (full) s = `This room is full (${MAX_PLAYERS} players). You can join the next round.`;
    else if (!mine && fillMode && nextFill < N() * N()) s = `Tap a box to place ${nextFill + 1}`;
    else if (!mine) s = 'Arrange your numbers, then press I\'m ready';
    else if (isHost) s = ready.length < 2 ? 'Waiting for at least one more player to get ready' : `${ready.length} of ${MAX_PLAYERS} players ready. Start when everyone's in`;
    else s = 'You\'re ready. Waiting for the host to start';
    $('lobbyStatus').textContent = s;
    return;
  }

  show('game');
  $('gameCode').textContent = code;
  const inGame = (game.order || []).includes(pkey);
  const called = calledSet();
  const board = inGame ? myBoard() : null;
  const done = board ? linesDone(board, called) : [];
  const W = WORD();
  const count = Math.min(done.length, W.length);
  const win = winner();
  const tk = turnKey();
  const myTurn = inGame && tk === pkey && !win;
  const last = calls.length ? calls[calls.length - 1] : null;

  const lettersEl = $('letters');
  if (lettersEl.dataset.word !== W) {
    lettersEl.dataset.word = W;
    lettersEl.style.setProperty('--n', W.length);
    lettersEl.classList.toggle('ten', W.length === 10);
    lettersEl.classList.toggle('seven', W.length === 7);
    lettersEl.innerHTML = [...W].map(ch => `<div class="letter">${ch}</div>`).join('');
  }
  [...lettersEl.children].forEach((el, i) => el.classList.toggle('struck', i < count));
  $('bingoBtn').textContent = `Call ${CALL_LABEL[N()]}!`;
  document.querySelector('#win h2').textContent = `${CALL_LABEL[N()]}!`;

  const tb = $('turnbar');
  tb.classList.toggle('mine', myTurn);
  if (win) tb.innerHTML = `<b>${esc(win.name)}</b> called ${CALL_LABEL[N()]}!`;
  else if (myTurn) tb.innerHTML = '<b>Your turn.</b> Tap a number on your grid to call it';
  else if (tk && players[tk]) tb.innerHTML = `Waiting for <b>${esc(players[tk].name)}</b> to call a number`;
  else tb.textContent = 'Waiting…';
  const callKey = last ? round() + ':' + last.n : 'none';
  if (callKey !== lastCallKey) {
    lastCallKey = callKey;
    $('lastcall').innerHTML = last
      ? `<span>${esc(players[last.by]?.name || 'Someone')} called</span><span class="ball" style="--c:var(--ball-${(last.n % 5) + 1})">${last.n}</span>`
      : '<span>No numbers called yet</span>';
  }

  if (board) {
    renderGrid($('playGrid'), board, {
      hit: called, last: last?.n,
      canTap: (n) => myTurn && !busy && !called.has(n),
      onTap: (n) => callNumber(n)
    });
    drawLines($('lines'), done, N());
  } else {
    $('playGrid').innerHTML = ''; $('lines').innerHTML = '';
  }
  $('gameNote').textContent = inGame ? '' : 'This game started before you joined. You can play in the next round.';

  const claimed = me()?.bingoRound === round();
  $('bingoBtn').hidden = !(inGame && count >= W.length && !win && !claimed);
  $('skipBtn').hidden = !(isHost && !win && tk && tk !== pkey);
  $('themeBtn').hidden = !isHost;
  if (!isHost) $('gameThemePanel').hidden = true;
  renderThemePicker($('gameThemes'));
  playerList($('gamePlayers'), 'game');

  if (win) {
    document.querySelector('#win .greet').textContent = THEMES[themeOf(game.theme)].greet;
    if ($('win').hidden) celebrate(themeOf(game.theme));
    $('win').hidden = false;
    $('winText').textContent = win.key === pkey ? `You won in ${calls.length} calls!` : `${win.name} won this round.`;
    $('againBtn').hidden = !isHost;
    $('againNote').textContent = isHost ? '' : 'Waiting for the host to start the next round';
  } else $('win').hidden = true;
}

/* ---------- live room subscription ---------- */
function subscribeRoom(c) {
  unsubscribe();
  code = c; game = null; players = {}; calls = [];
  store.set('bingo.room', c);
  try { if (location.hash !== '#' + c) history.replaceState(null, '', '#' + c); } catch {}
  lastRoomKey = ''; lastCallKey = '';
  roomRef = room(c);
  roomRef.on('value', snap => {
    const v = snap.val();
    if (!v) { leaveRoom('That room no longer exists.'); return; }
    const { chat, ...rest } = v;
    const key = JSON.stringify(rest);
    if (key === lastRoomKey) return;
    lastRoomKey = key;
    game = { hostKey: v.hostKey, status: v.status, round: v.round || 1, order: v.order || [], skips: v.skips || 0, size: sizeOf(v.size), theme: themeOf(v.theme) };
    applySkin(game.theme);
    players = {};
    Object.entries(v.players || {}).forEach(([k, p]) => { players[k] = Object.assign({ key: k }, p); });
    calls = Object.values((v.calls || {})['r' + game.round] || {})
      .filter(d => typeof d.n === 'number')
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    render();
  }, () => leaveRoom('Lost access to the room. Check your connection and try again.'));
  subscribeChat(c);
}

function unsubscribe() {
  if (roomRef) roomRef.off(); roomRef = null;
  if (chatQuery) chatQuery.off(); chatQuery = null;
  closeChat(); $('chatFab').hidden = true;
}

/* ---------- room chat ---------- */
function subscribeChat(c) {
  chatLoaded = false; unread = 0; updateBadge();
  $('chatList').innerHTML = '<li class="empty">No messages yet. Say hi or send a 🪔</li>';
  $('chatFab').hidden = false;
  chatQuery = room(c).child('chat').limitToLast(60);
  chatQuery.on('child_added', snap => {
    const m = snap.val();
    if (!m || typeof m.text !== 'string') return;
    addChatItem(m);
    if (chatLoaded) {
      if (m.emoji) floatEmoji(m.text, m.by === pkey ? 'You' : m.name);
      if (!chatOpen && m.by !== pkey) { unread++; updateBadge(); }
    }
  });
  chatQuery.once('value').then(() => { chatLoaded = true; }).catch(() => { chatLoaded = true; });
}

function addChatItem(m) {
  const list = $('chatList');
  list.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.className = 'msg' + (m.by === pkey ? ' mine' : '') + (m.emoji ? ' big' : '');
  const who = document.createElement('span'); who.className = 'who'; who.textContent = m.by === pkey ? 'You' : (m.name || 'Someone');
  const text = document.createElement('span'); text.className = 'text'; text.textContent = m.text;
  li.append(who, text); list.appendChild(li);
  while (list.children.length > 60) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}

function updateBadge() {
  const b = $('chatBadge');
  b.hidden = unread === 0; b.textContent = unread > 9 ? '9+' : String(unread);
  $('chatFab').setAttribute('aria-label', unread ? `Open room chat, ${unread} new` : 'Open room chat');
}

function openChat() {
  chatOpen = true; unread = 0; updateBadge();
  $('chatPanel').hidden = false; $('chatFab').hidden = true; $('chatFab').setAttribute('aria-expanded', 'true');
  const list = $('chatList'); list.scrollTop = list.scrollHeight;
  $('chatInput').focus();
}
function closeChat() {
  chatOpen = false; $('chatPanel').hidden = true; $('chatFab').setAttribute('aria-expanded', 'false');
  if (code) $('chatFab').hidden = false;
}

async function sendChat(text, emoji) {
  text = String(text || '').trim().slice(0, 200);
  if (!text || !code) return false;
  const now = Date.now();
  if (now - lastSent < 600) return false;
  lastSent = now;
  const name = players[pkey]?.name || myName() || 'Someone';
  try { await room(code).child('chat').push({ by: pkey, name, text, emoji: !!emoji, at: TS }); return true; }
  catch { return false; }
}

function floatEmoji(e, who) {
  if (calm) return;
  const s = document.createElement('span');
  s.className = 'float-emoji';
  s.style.left = (8 + Math.random() * 78) + '%';
  s.style.setProperty('--dx', ((Math.random() - .5) * 120).toFixed(0) + 'px');
  s.textContent = e;
  if (who) { const n = document.createElement('small'); n.textContent = who; s.appendChild(n); }
  $('floatLayer').appendChild(s);
  setTimeout(() => s.remove(), 3000);
}

/* ---------- actions ---------- */
function myName() { return ($('nameInput').value || '').trim().slice(0, 20); }

async function joinRoom(c, isCreate) {
  const name = myName();
  if (!name) { $('homeNote').textContent = 'Type your name first.'; $('nameInput').focus(); return; }
  store.set('bingo.name', name);
  try {
    if (!isCreate) {
      const snap = await room(c).child('hostKey').get();
      if (!snap.exists()) { $('homeNote').textContent = `No room with code ${c}. Check the code and try again.`; return; }
    }
    const ref = room(c).child('players/' + pkey);
    const existing = await ref.child('joinedAt').get();
    if (existing.exists()) await ref.update({ name });
    else await ref.set({ name, joinedAt: Date.now(), round: 0 });
  } catch {
    $('homeNote').textContent = 'Couldn\'t join the room. Check your connection and try again.';
    return;
  }
  draft = shuffled(5); fillMode = false; nextFill = 0;
  $('homeNote').textContent = '';
  subscribeRoom(c);
}

async function createRoom() {
  if (busy) return;
  if (!myName()) { $('homeNote').textContent = 'Type your name first.'; $('nameInput').focus(); return; }
  busy = true;
  try {
    let c;
    for (let t = 0; t < 8; t++) {
      c = Array.from({length: 4}, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
      if (!(await room(c).child('hostKey').get()).exists()) break;
    }
    await room(c).set({ hostKey: pkey, status: 'lobby', round: 1, skips: 0, size: 5, createdAt: TS });
    await joinRoom(c, true);
  } catch {
    $('homeNote').textContent = 'Couldn\'t create the room. Try again.';
  } finally { busy = false; }
}

function leaveRoom(msg) {
  unsubscribe();
  code = null; game = null; players = {}; calls = [];
  store.del('bingo.room');
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  show('home');
  applySkin('diwali'); $('gameThemePanel').hidden = true;
  $('win').hidden = true;
  $('homeNote').textContent = msg || '';
}

async function setReady(on) {
  if (busy) return; busy = true;
  const prev = myBoard();
  try {
    await room(code).child('players/' + pkey).update(on
      ? { board: draft.slice(), round: round(), bingoAt: null, bingoRound: null }
      : { board: null });
    if (!on && prev) { draft = prev.slice(); fillMode = false; }
  } catch { $('lobbyStatus').textContent = 'Couldn\'t save. Try again.'; }
  finally { busy = false; render(); }
}

async function startGame() {
  const order = readyPlayers().slice(0, MAX_PLAYERS).map(p => p.key);
  if (order.length < 2) return;
  await room(code).update({ status: 'playing', order, skips: 0 });
}

async function callNumber(n) {
  if (busy) return;
  busy = true; render();
  try {
    await room(code).child(`calls/r${round()}/n${n}`).set({ n, by: pkey, at: TS });
  } catch { $('gameNote').textContent = 'That call didn\'t go through. Try again.'; }
  finally { busy = false; render(); }
}

async function claimBingo() {
  $('bingoBtn').hidden = true;
  try { await room(code).child('players/' + pkey).update({ bingoAt: TS, bingoRound: round() }); }
  catch { $('bingoBtn').hidden = false; }
}

async function setMode(size) {
  if (!game || game.hostKey !== pkey || game.status !== 'lobby' || N() === size) return;
  draft = shuffled(size); fillMode = false; nextFill = 0;
  try { await room(code).update({ size }); }
  catch { $('lobbyStatus').textContent = 'Couldn\'t change the mode. Try again.'; }
}

async function playAgain() {
  draft = shuffled(N()); fillMode = false; nextFill = 0;
  const old = round();
  await room(code).update({ status: 'lobby', round: old + 1, order: null, skips: 0, ['calls/r' + old]: null });
}

/* ---------- wiring ---------- */
$('nameInput').value = store.get('bingo.name') || '';
$('nameInput').addEventListener('input', () => store.set('bingo.name', myName()));
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('createBtn').onclick = createRoom;
$('joinBtn').onclick = () => { const c = $('codeInput').value.trim(); if (c.length === 4) joinRoom(c, false); else $('homeNote').textContent = 'Room codes have 4 letters.'; };
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('mode5').onclick = () => setMode(5);
$('mode7').onclick = () => setMode(7);
$('mode10').onclick = () => setMode(10);
$('shuffleBtn').onclick = () => { draft = shuffled(N()); fillMode = false; nextFill = 0; render(); };
$('manualBtn').onclick = () => { draft = Array(N() * N()).fill(null); fillMode = true; nextFill = 0; render(); };
$('readyBtn').onclick = () => setReady(true);
$('unreadyBtn').onclick = () => setReady(false);
$('startBtn').onclick = startGame;
$('leaveBtn').onclick = () => leaveRoom();
$('leaveBtn2').onclick = () => leaveRoom();
$('bingoBtn').onclick = claimBingo;
$('againBtn').onclick = playAgain;
$('skipBtn').onclick = () => room(code).update({ skips: (game.skips || 0) + 1 });
$('themeBtn').onclick = () => { const p = $('gameThemePanel'); p.hidden = !p.hidden; $('themeBtn').setAttribute('aria-expanded', String(!p.hidden)); };
/* ---------- Themes: background ambience and win celebrations ---------- */
const THEMES = {
  diwali:    { name: 'Diwali',    greet: 'Shubh Deepavali!' },
  christmas: { name: 'Christmas', greet: 'Merry Christmas!' },
  cricket:   { name: 'Cricket',   greet: 'What a SIXER!' },
  halloween: { name: 'Halloween', greet: 'Spooktacular win!' },
  space:     { name: 'Space',     greet: 'Mission complete!' }
};
const themeOf = t => THEMES[t] ? t : 'diwali';
const calm = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const fxColors = () => { const cs = getComputedStyle(document.documentElement); return ['--gold', '--marigold', '--rani', '--ball-4', '--ball-5', '--cream'].map(v => cs.getPropertyValue(v).trim()); };
const rnd = (a, b) => a + Math.random() * (b - a);

function applySkin(t) {
  t = themeOf(t);
  if (document.documentElement.dataset.skin === t) return;
  document.documentElement.dataset.skin = t;
  startAmbient(t);
}

function drawBat(ctx, x, y, s, flap, color) {
  const w = Math.sin(flap) * .6;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 0, 2.2, 3.2, 0, 0, 6.29); ctx.fill();
  for (const dir of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(0, -1);
    ctx.quadraticCurveTo(dir * 6, -6 - w * 6, dir * 13, -2 - w * 8);
    ctx.quadraticCurveTo(dir * 10, 0, dir * 9, 3 - w * 2);
    ctx.quadraticCurveTo(dir * 6, 1, dir * 4.5, 4);
    ctx.quadraticCurveTo(dir * 3, 1.5, 0, 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStar(ctx, x, y, r, rot, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * .45 : r; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill(); ctx.restore();
}

/* One looping canvas behind the page; its contents depend on the theme */
let ambientRaf = 0;
function startAmbient(skin) {
  cancelAnimationFrame(ambientRaf);
  const cv = $('embers'); if (!cv) return;
  const ctx = cv.getContext('2d'); let W, H, dpr;
  const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; };
  size(); window.onresize = size;
  ctx.clearRect(0, 0, W, H);
  if (calm) return;
  let parts = [], draw;

  if (skin === 'christmas') {
    const make = y => ({ x: rnd(0, W), y: y ?? -10, r: rnd(1, 3.4) * dpr, vy: rnd(.4, 1.3) * dpr, sw: rnd(0, 6.28), a: rnd(.5, .95) });
    parts = Array.from({ length: 80 }, () => make(rnd(0, H)));
    draw = () => { for (const p of parts) {
      p.y += p.vy; p.sw += .015; p.x += Math.sin(p.sw) * .5 * dpr;
      if (p.y > H + 10) Object.assign(p, make());
      ctx.globalAlpha = p.a; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill();
    } ctx.globalAlpha = 1; };
  } else if (skin === 'cricket') {
    draw = () => {
      if (Math.random() < .035) parts.push({ x: rnd(0, W), y: rnd(0, H * .3), life: 1, r: rnd(10, 26) * dpr });
      for (const p of parts) {
        p.life -= .06; if (p.life <= 0) continue;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(255,255,240,${p.life})`); g.addColorStop(1, 'rgba(255,255,240,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill();
      }
      parts = parts.filter(p => p.life > 0);
    };
  } else if (skin === 'halloween') {
    const makeBat = () => { const dir = Math.random() < .5 ? 1 : -1; return { bat: 1, dir, x: dir > 0 ? -40 * dpr : W + 40 * dpr, y: rnd(H * .08, H * .55), vx: dir * rnd(.8, 1.8) * dpr, s: rnd(1.1, 2.1) * dpr, f: rnd(0, 6.28), bob: rnd(0, 6.28) }; };
    const makeWisp = y => ({ x: rnd(0, W), y: y ?? H + 10, r: rnd(1, 2.4) * dpr, vy: rnd(.2, .5) * dpr, sw: rnd(0, 6.28), a: rnd(.25, .6) });
    parts = Array.from({ length: 5 }, makeBat).concat(Array.from({ length: 24 }, () => makeWisp(rnd(0, H))));
    parts.forEach(p => { if (p.bat) p.x = rnd(0, W); });
    draw = () => { for (const p of parts) {
      if (p.bat) {
        p.x += p.vx; p.f += .35; p.bob += .04; const y = p.y + Math.sin(p.bob) * 12 * dpr;
        if (p.x < -60 * dpr || p.x > W + 60 * dpr) Object.assign(p, makeBat());
        drawBat(ctx, p.x, y, p.s, p.f, 'rgba(10,4,18,.85)');
      } else {
        p.y -= p.vy; p.sw += .02; p.x += Math.sin(p.sw) * .3 * dpr;
        if (p.y < -10) Object.assign(p, makeWisp());
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
        g.addColorStop(0, `rgba(160,255,140,${p.a})`); g.addColorStop(1, 'rgba(160,255,140,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 5, 0, 6.29); ctx.fill();
      }
    } };
  } else if (skin === 'space') {
    parts = Array.from({ length: 110 }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(.5, 1.8) * dpr, v: rnd(.05, .35) * dpr, tw: rnd(0, 6.28) }));
    let shoot = null;
    draw = () => {
      for (const p of parts) {
        p.x -= p.v; p.tw += .05; if (p.x < -2) { p.x = W + 2; p.y = rnd(0, H); }
        ctx.globalAlpha = .45 + .55 * Math.abs(Math.sin(p.tw)); ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!shoot && Math.random() < .004) shoot = { x: rnd(W * .3, W), y: rnd(0, H * .4), life: 1 };
      if (shoot) {
        shoot.x -= 14 * dpr; shoot.y += 6 * dpr; shoot.life -= .03;
        const g = ctx.createLinearGradient(shoot.x, shoot.y, shoot.x + 120 * dpr, shoot.y - 52 * dpr);
        g.addColorStop(0, `rgba(180,250,255,${shoot.life})`); g.addColorStop(1, 'rgba(180,250,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(shoot.x, shoot.y); ctx.lineTo(shoot.x + 120 * dpr, shoot.y - 52 * dpr); ctx.stroke();
        if (shoot.life <= 0) shoot = null;
      }
    };
  } else {
    const make = y => ({ x: rnd(0, W), y: y ?? H + rnd(0, H * .3), r: rnd(1, 3.2) * dpr, vy: rnd(.25, .85) * dpr, sw: rnd(0, 6.28), a: rnd(.3, .9) });
    parts = Array.from({ length: 46 }, () => make(rnd(0, H)));
    draw = () => { for (const b of parts) {
      b.y -= b.vy; b.sw += .02; b.x += Math.sin(b.sw) * .3 * dpr;
      if (b.y < -10) Object.assign(b, make());
      const tw = .6 + .4 * Math.sin(b.sw * 3);
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 4);
      g.addColorStop(0, `rgba(255,214,120,${b.a * tw})`); g.addColorStop(1, 'rgba(255,154,31,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 4, 0, 6.29); ctx.fill();
    } };
  }
  (function tick() {
    if (!document.hidden) { ctx.clearRect(0, 0, W, H); draw(); }
    ambientRaf = requestAnimationFrame(tick);
  })();
}

/* A temporary full-screen canvas for a win celebration */
function fxCanvas(ms, step, trails) {
  const cv = document.createElement('canvas'); cv.id = 'fireworks'; document.body.appendChild(cv);
  const ctx = cv.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
  const t0 = performance.now();
  (function tick(t) {
    if (trails) { ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
    else ctx.clearRect(0, 0, W, H);
    step(ctx, W, H, dpr, t - t0);
    if (t - t0 < ms) requestAnimationFrame(tick); else cv.remove();
  })(t0);
}

function celebrate(skin) {
  if (calm) return;
  const colors = fxColors();
  if (skin === 'christmas') {
    const cols = ['#d7263d', '#1e8a4c', '#f2c14e', '#ffffff'];
    let bits = [];
    fxCanvas(4200, (ctx, W, H, dpr, el) => {
      if (!bits.length) bits = Array.from({ length: 130 }, () => ({ x: rnd(0, W), y: rnd(-H, 0), vy: rnd(2, 5) * dpr, vx: rnd(-1, 1) * dpr, r: rnd(5, 11) * dpr, rot: rnd(0, 6), vr: rnd(-.08, .08), star: Math.random() < .45, c: cols[Math.floor(rnd(0, 4))] }));
      for (const b of bits) {
        b.y += b.vy; b.x += b.vx; b.rot += b.vr;
        if (b.star) drawStar(ctx, b.x, b.y, b.r, b.rot, b.c === '#ffffff' ? '#f2c14e' : b.c);
        else { ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.fillStyle = b.c; ctx.fillRect(-b.r, -b.r, b.r * 2, b.r * 2);
          ctx.fillStyle = b.c === '#f2c14e' ? '#d7263d' : '#f2c14e'; ctx.fillRect(-b.r * .18, -b.r, b.r * .36, b.r * 2); ctx.fillRect(-b.r, -b.r * .18, b.r * 2, b.r * .36); ctx.restore(); }
      }
    });
  } else if (skin === 'cricket') {
    const cols = ['#ff8c1a', '#ffffff', '#1d8a3a', '#1d3a66', '#ffd23f'];
    let bits = [];
    fxCanvas(4000, (ctx, W, H, dpr, el) => {
      if (el < 350) { ctx.fillStyle = `rgba(255,255,240,${.6 * (1 - el / 350)})`; ctx.fillRect(0, 0, W, H); }
      if (el < 1200 && Math.random() < .9) for (const side of [0, 1]) for (let i = 0; i < 4; i++) {
        const ang = side ? rnd(-2.6, -2.0) : rnd(-1.1, -0.55), sp = rnd(10, 18) * dpr;
        bits.push({ x: side ? W : 0, y: H, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, w: rnd(5, 10) * dpr, h: rnd(3, 6) * dpr, rot: rnd(0, 6), vr: rnd(-.3, .3), c: cols[Math.floor(rnd(0, 5))] });
      }
      for (const b of bits) {
        b.vy += .28 * dpr; b.vx *= .99; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
    });
  } else if (skin === 'halloween') {
    let bats = [];
    fxCanvas(3800, (ctx, W, H, dpr, el) => {
      if (!bats.length) bats = Array.from({ length: 46 }, () => { const a = rnd(0, 6.28), sp = rnd(1.5, 4.5) * dpr; return { x: W / 2, y: H * .45, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.2 * dpr, s: rnd(1.4, 3.2) * dpr, f: rnd(0, 6.28) }; });
      for (const b of bats) { b.vx *= 1.012; b.vy *= 1.012; b.x += b.vx; b.y += b.vy; b.f += .45; drawBat(ctx, b.x, b.y, b.s, b.f, '#120618'); }
    });
  } else if (skin === 'space') {
    let rocket = null, sparks = [], burst = false;
    fxCanvas(4300, (ctx, W, H, dpr, el) => {
      if (!rocket) rocket = { x: W / 2, y: H + 40 * dpr };
      if (!burst) {
        rocket.y -= (6 + el / 120) * dpr;
        for (let i = 0; i < 4; i++) sparks.push({ x: rocket.x + rnd(-5, 5) * dpr, y: rocket.y + 34 * dpr, vx: rnd(-1, 1) * dpr, vy: rnd(2, 5) * dpr, life: 1, c: Math.random() < .5 ? '#ffe066' : '#ff8ae0' });
        const r = rocket, s = dpr;
        ctx.save(); ctx.translate(r.x, r.y);
        ctx.fillStyle = '#e6ecff'; ctx.beginPath(); ctx.moveTo(0, -34 * s); ctx.quadraticCurveTo(14 * s, -10 * s, 11 * s, 24 * s); ctx.lineTo(-11 * s, 24 * s); ctx.quadraticCurveTo(-14 * s, -10 * s, 0, -34 * s); ctx.fill();
        ctx.fillStyle = '#5ef2ff'; ctx.beginPath(); ctx.arc(0, -6 * s, 5 * s, 0, 6.29); ctx.fill();
        ctx.fillStyle = '#ff8ae0'; ctx.beginPath(); ctx.moveTo(-11 * s, 12 * s); ctx.lineTo(-20 * s, 30 * s); ctx.lineTo(-10 * s, 24 * s); ctx.fill();
        ctx.beginPath(); ctx.moveTo(11 * s, 12 * s); ctx.lineTo(20 * s, 30 * s); ctx.lineTo(10 * s, 24 * s); ctx.fill();
        ctx.restore();
        if (rocket.y < H * .28) {
          burst = true;
          for (let i = 0; i < 120; i++) { const a = i / 120 * 6.283, sp = rnd(2, 7) * dpr; sparks.push({ x: rocket.x, y: rocket.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c: colors[Math.floor(rnd(0, colors.length))] }); }
        }
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const p of sparks) { if (p.life <= 0) continue; p.vx *= .97; p.vy *= .97; p.x += p.vx; p.y += p.vy; p.life -= .016;
        ctx.globalAlpha = Math.max(p.life, 0); ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2 * dpr, 0, 6.29); ctx.fill(); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    });
  } else {
    const sparks = []; let shots = 0, next = 0;
    fxCanvas(4200, (ctx, W, H, dpr, el) => {
      if (shots < 7 && el >= next) {
        shots++; next += 420;
        const x = W * rnd(.15, .85), y = H * rnd(.15, .5), c = colors[Math.floor(rnd(0, colors.length))];
        for (let i = 0; i < 70; i++) { const a = i / 70 * 6.283, sp = rnd(2.5, 6) * dpr; sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, c }); }
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const s of sparks) { if (s.life <= 0) continue; s.vx *= .97; s.vy = s.vy * .97 + .06 * dpr; s.x += s.vx; s.y += s.vy; s.life -= .014;
        ctx.globalAlpha = Math.max(s.life, 0); ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(s.x, s.y, 2.2 * dpr, 0, 6.29); ctx.fill(); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }, true);
  }
}

/* ---------- theme picker (host chooses, everyone follows) ---------- */
function renderThemePicker(el) {
  if (!el.children.length) {
    el.innerHTML = Object.entries(THEMES).map(([k, t]) =>
      `<button type="button" class="theme-opt" data-theme="${k}" aria-pressed="false"><span class="sw sw-${k}" aria-hidden="true"></span>${t.name}</button>`).join('');
    el.addEventListener('click', e => { const b = e.target.closest('.theme-opt'); if (b && !b.disabled) setTheme(b.dataset.theme); });
  }
  const cur = themeOf(game?.theme), isHost = game?.hostKey === pkey;
  [...el.children].forEach(b => { const on = b.dataset.theme === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.disabled = !isHost; });
}

async function setTheme(t) {
  if (!game || game.hostKey !== pkey || themeOf(game.theme) === t) return;
  applySkin(t);
  try { await room(code).update({ theme: t }); } catch { applySkin(game.theme); }
}

$('chatFab').onclick = openChat;
$('chatClose').onclick = () => { closeChat(); $('chatFab').focus(); };
$('chatPanel').addEventListener('keydown', e => { if (e.key === 'Escape') { closeChat(); $('chatFab').focus(); } });
$('chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const inp = $('chatInput');
  if (await sendChat(inp.value, false)) inp.value = '';
  inp.focus();
});
$('emojiRow').addEventListener('click', e => {
  const b = e.target.closest('.emoji'); if (b) sendChat(b.dataset.e, true);
});

$('copyBtn').onclick = async () => {
  const link = location.origin + location.pathname + '#' + code;
  const text = `Join my Bingo game! Room code ${code}: ${link}`;
  try { await navigator.clipboard.writeText(text); $('copyBtn').textContent = 'Copied'; }
  catch { $('copyBtn').textContent = 'Code: ' + code; }
  setTimeout(() => $('copyBtn').textContent = 'Copy invite', 1800);
};

/* ---------- start ---------- */
startAmbient('diwali');

(function boot() {
  const cfg = window.FIREBASE_CONFIG;
  if (!window.firebase || !cfg || !cfg.databaseURL || String(cfg.apiKey).includes('PASTE')) {
    $('homeNote').textContent = 'Game server not set up yet. Add your Firebase settings to firebase-config.js (see README).';
    return;
  }
  firebase.initializeApp(cfg);
  rdb = firebase.database();
  TS = firebase.database.ServerValue.TIMESTAMP;

  rdb.ref('.info/connected').on('value', s => {
    const on = !!s.val();
    $('createBtn').disabled = !on; $('joinBtn').disabled = !on;
    if (view === 'home') $('homeNote').textContent = on ? '' : 'Connecting…';
    if (view === 'game' && !on) $('gameNote').textContent = 'Reconnecting…';
  });

  const hashCode = (location.hash || '').slice(1).toUpperCase();
  const saved = /^[A-Z]{4}$/.test(hashCode) ? hashCode : store.get('bingo.room');
  if (saved && myName()) joinRoom(saved, false);
  else if (saved) $('codeInput').value = saved;
})();
