const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const newCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const alive = r => Object.values(r.players).filter(p => p.alive);
const clean = s => String(s || '').trim().slice(0, 200);

function view(r, pid) {
  const me = r.players[pid];
  const over = r.phase === 'over';
  const chat = r.chat.filter(m => m.ch === 'all' || me.role === 'mafia').slice(-60);
  return {
    code: r.code, phase: r.phase, round: r.round, winner: r.winner, isHost: r.host === pid,
    me: { id: pid, name: me.name, role: me.role, alive: me.alive },
    acted: r.phase === 'night' ? !!me.acted : !!r.votes[pid],
    votes: r.phase === 'day' ? r.votes : {},
    notes: me.notes, log: r.log.slice(-40), chat,
    players: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, alive: p.alive, connected: p.connected,
      role: (over || (me.role === 'mafia' && p.role === 'mafia')) ? p.role : undefined
    }))
  };
}
function broadcast(r) {
  for (const p of Object.values(r.players)) if (p.sid) io.to(p.sid).emit('state', view(r, p.id));
}
const say = (r, t) => r.log.push(t);

function startGame(r) {
  const ids = shuffle(Object.keys(r.players));
  const n = ids.length, mafia = Math.max(1, Math.floor(n / 4));
  const roles = Array(mafia).fill('mafia');
  if (n >= 5) roles.push('doctor', 'detective');
  while (roles.length < n) roles.push('town');
  shuffle(roles);
  ids.forEach((id, i) => Object.assign(r.players[id], { role: roles[i], alive: true, notes: [], acted: false }));
  r.round = 1; r.log = ['The game begins. Night falls...']; r.chat = []; r.winner = null;
  startNight(r);
}
function startNight(r) {
  r.phase = 'night';
  r.night = { kill: {}, save: null, check: null };
  Object.values(r.players).forEach(p => p.acted = false);
}
function checkWin(r) {
  const m = alive(r).filter(p => p.role === 'mafia').length;
  const t = alive(r).length - m;
  if (m === 0) r.winner = 'Town';
  else if (m >= t) r.winner = 'Mafia';
  if (r.winner) { r.phase = 'over'; say(r, `${r.winner} wins!`); return true; }
  return false;
}
function nightDone(r) {
  return alive(r).every(p => !['mafia', 'doctor', 'detective'].includes(p.role) || p.acted);
}
function endNight(r) {
  const counts = {};
  Object.values(r.night.kill).forEach(t => counts[t] = (counts[t] || 0) + 1);
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  const victim = top.length ? top[Math.floor(Math.random() * top.length)] : null;
  say(r, `--- Day ${r.round} ---`);
  if (victim && victim !== r.night.save) {
    r.players[victim].alive = false;
    say(r, `${r.players[victim].name} was killed in the night. They were ${r.players[victim].role}.`);
  } else say(r, 'Nobody died last night.');
  if (checkWin(r)) return;
  r.phase = 'day'; r.votes = {};
}
function dayDone(r) { return alive(r).every(p => r.votes[p.id]); }
function endDay(r) {
  const counts = {};
  Object.values(r.votes).forEach(t => { if (t !== 'skip') counts[t] = (counts[t] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  if (top.length === 1) {
    const p = r.players[top[0]]; p.alive = false;
    say(r, `The town eliminated ${p.name}. They were ${p.role}.`);
  } else say(r, 'The vote was tied or skipped. Nobody was eliminated.');
  if (checkWin(r)) return;
  r.round++; say(r, 'Night falls...'); startNight(r);
}

io.on('connection', socket => {
  const R = () => rooms[socket.data.code];
  socket.on('join', ({ name, code, pid }) => {
    name = clean(name).slice(0, 16);
    if (!name) return socket.emit('err', 'Enter a name');
    let r = code ? rooms[String(code).toUpperCase()] : null;
    if (code && !r) return socket.emit('err', 'Room not found');
    if (!r) {
      do { code = newCode(); } while (rooms[code]);
      r = rooms[code] = { code, players: {}, phase: 'lobby', round: 0, votes: {}, log: [], chat: [], host: null };
    }
    let p = r.players[pid];
    if (!p) {
      if (r.phase !== 'lobby') return socket.emit('err', 'Game already started');
      if (Object.values(r.players).some(x => x.name.toLowerCase() === name.toLowerCase())) return socket.emit('err', 'Name taken');
      pid = Math.random().toString(36).slice(2, 10);
      p = r.players[pid] = { id: pid, name, alive: true, notes: [] };
      if (!r.host) r.host = pid;
    }
    p.sid = socket.id; p.connected = true;
    socket.data.code = r.code; socket.data.pid = pid;
    socket.emit('joined', { pid });
    broadcast(r);
  });
  socket.on('start', () => {
    const r = R(); if (!r || r.host !== socket.data.pid || r.phase !== 'lobby') return;
    if (Object.keys(r.players).length < 4) return socket.emit('err', 'Need at least 4 players');
    startGame(r); broadcast(r);
  });
  socket.on('act', target => {
    const r = R(); const me = r && r.players[socket.data.pid];
    if (!r || !me || !me.alive) return;
    if (r.phase === 'night' && !me.acted) {
      const t = r.players[target]; if (!t || !t.alive) return;
      if (me.role === 'mafia') { if (t.role === 'mafia') return; r.night.kill[me.id] = target; }
      else if (me.role === 'doctor') r.night.save = target;
      else if (me.role === 'detective') {
        if (target === me.id) return;
        me.notes.push(`Night ${r.round}: ${t.name} is ${t.role === 'mafia' ? 'MAFIA' : 'not Mafia'}.`);
      } else return;
      me.acted = true;
      if (nightDone(r)) endNight(r);
    } else if (r.phase === 'day' && !r.votes[me.id]) {
      if (target !== 'skip' && !(r.players[target] && r.players[target].alive)) return;
      r.votes[me.id] = target;
      if (dayDone(r)) endDay(r);
    }
    broadcast(r);
  });
  socket.on('force', () => { // host skips AFK players
    const r = R(); if (!r || r.host !== socket.data.pid) return;
    if (r.phase === 'night') endNight(r); else if (r.phase === 'day') endDay(r);
    broadcast(r);
  });
  socket.on('chat', text => {
    const r = R(); const me = r && r.players[socket.data.pid]; text = clean(text);
    if (!me || !text) return;
    let ch = 'all';
    if (r.phase === 'night' || r.phase === 'day') {
      if (!me.alive) return;
      if (r.phase === 'night') { if (me.role !== 'mafia') return; ch = 'mafia'; }
    }
    r.chat.push({ from: me.name, text, ch }); broadcast(r);
  });
  socket.on('again', () => {
    const r = R(); if (!r || r.host !== socket.data.pid || r.phase !== 'over') return;
    Object.values(r.players).forEach(p => Object.assign(p, { role: undefined, alive: true, notes: [] }));
    Object.assign(r, { phase: 'lobby', log: [], chat: [], votes: {}, winner: null });
    broadcast(r);
  });
  socket.on('disconnect', () => {
    const r = R(); const p = r && r.players[socket.data.pid];
    if (p && p.sid === socket.id) { p.connected = false; broadcast(r); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mafia running on http://localhost:${PORT}`));
