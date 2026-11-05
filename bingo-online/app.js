/* Bingo (5x5 BINGO, 7x7 FRIENDS, 10x10 BINGO CHIPS) — live multiplayer over Firebase Realtime Database.
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
let roomRef = null;
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
  $('lastcall').innerHTML = last
    ? `<span>${esc(players[last.by]?.name || 'Someone')} called</span><span class="ball" style="--c:var(--ball-${(last.n % 5) + 1})">${last.n}</span>`
    : '<span>No numbers called yet</span>';

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
  playerList($('gamePlayers'), 'game');

  if (win) {
    if ($('win').hidden) confetti();
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
  roomRef = room(c);
  roomRef.on('value', snap => {
    const v = snap.val();
    if (!v) { leaveRoom('That room no longer exists.'); return; }
    game = { hostKey: v.hostKey, status: v.status, round: v.round || 1, order: v.order || [], skips: v.skips || 0, size: sizeOf(v.size) };
    players = {};
    Object.entries(v.players || {}).forEach(([k, p]) => { players[k] = Object.assign({ key: k }, p); });
    calls = Object.values((v.calls || {})['r' + game.round] || {})
      .filter(d => typeof d.n === 'number')
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    render();
  }, () => leaveRoom('Lost access to the room. Check your connection and try again.'));
}

function unsubscribe() { if (roomRef) roomRef.off(); roomRef = null; }

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
/* ---------- confetti on a win ---------- */
function confetti() {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch {}
  const cv = document.createElement('canvas');
  cv.id = 'confetti'; document.body.appendChild(cv);
  const ctx = cv.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
  const cs = getComputedStyle(document.documentElement);
  const colors = [1, 2, 3, 4, 5].map(i => cs.getPropertyValue('--ball-' + i).trim()).concat(cs.getPropertyValue('--dauber').trim());
  const bits = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - .5) * W * .3, y: H * .35,
    vx: (Math.random() - .5) * 18 * dpr, vy: (-Math.random() * 16 - 6) * dpr,
    w: (6 + Math.random() * 8) * dpr, h: (4 + Math.random() * 6) * dpr,
    r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: colors[Math.floor(Math.random() * colors.length)]
  }));
  const end = performance.now() + 3200;
  (function tick(t) {
    ctx.clearRect(0, 0, W, H);
    bits.forEach(b => {
      b.vy += .45 * dpr; b.vx *= .99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    });
    if (t < end) requestAnimationFrame(tick); else cv.remove();
  })(performance.now());
}

$('copyBtn').onclick = async () => {
  const link = location.origin + location.pathname + '#' + code;
  const text = `Join my Bingo game! Room code ${code}: ${link}`;
  try { await navigator.clipboard.writeText(text); $('copyBtn').textContent = 'Copied'; }
  catch { $('copyBtn').textContent = 'Code: ' + code; }
  setTimeout(() => $('copyBtn').textContent = 'Copy invite', 1800);
};

/* ---------- start ---------- */
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
