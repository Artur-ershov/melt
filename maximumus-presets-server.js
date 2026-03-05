const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3222;
const DATA_FILE = path.join(__dirname, 'maximumus-presets.json');
const DATA_DIR = path.join(__dirname, 'data');
const PRIZES_FILE = path.join(DATA_DIR, 'ice-prizes.json');
const WINS_FILE = path.join(DATA_DIR, 'ice-wins.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Токены админки (в памяти): логин выдаёт токен, клиент шлёт его в заголовке
const adminTokens = new Set();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 ч
const tokenExpiry = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readPrizes() {
  try {
    ensureDataDir();
    if (!fs.existsSync(PRIZES_FILE)) return {};
    const raw = fs.readFileSync(PRIZES_FILE, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch (e) {
    console.error('Failed to read prizes:', e);
    return {};
  }
}

function writePrizes(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(PRIZES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write prizes:', e);
  }
}

function readWins() {
  try {
    ensureDataDir();
    if (!fs.existsSync(WINS_FILE)) return [];
    const raw = fs.readFileSync(WINS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Failed to read wins:', e);
    return [];
  }
}

function appendWin(entry) {
  const wins = readWins();
  wins.unshift({ ...entry, time: new Date().toISOString() });
  try {
    ensureDataDir();
    fs.writeFileSync(WINS_FILE, JSON.stringify(wins, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to append win:', e);
  }
}

function normalizeBoolean(val) {
  if (val === false) return false;
  if (val === true) return true;
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (v === 'false' || v === 'no' || v === '0') return false;
    if (v === 'true' || v === 'yes' || v === '1') return true;
  }
  return true;
}

function isAdminAuthValid(req) {
  if (!ADMIN_PASSWORD) return true; // без пароля в env — отключена защита (локально)
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !adminTokens.has(token)) return false;
  const exp = tokenExpiry.get(token);
  if (exp && Date.now() > exp) {
    adminTokens.delete(token);
    tokenExpiry.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (isAdminAuthValid(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function readPresetsFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch (e) {
    console.error('Failed to read presets:', e);
    return {};
  }
}

function writePresetsToDisk(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write presets:', e);
  }
}

const defaultParams = {
  aces: 1.0, dither: 1.0,
  lightMode: 0.0, lightInt: 1.8, lightWarmth: 0.5, lightRad: 0.45, lightFalloff: 0.1, sunX: 0.2, sunY: 0.5,
  texScale: 1.0, frostOpacity: 0.9, frostTint: 0.1, iceNormal: 1.5, refract: 0.05, chroma: 0.02, specular: 1.8, shadowStr: 0.6, sss: 0.3,
  meltRadius: 0.35, meltSpeed: 0.06, edgeDistort: 1.0, brushNoise: 0.4, brushHardness: 0.5, cleanCutoff: 0.95,
  waterShiny: 150.0, waterOpacity: 0.1,
  blurStr: 0.5, grain: 0.06, ambient: 0.25, emissive: 1.0, vignette: 0.4, parallax: 0.02,
  exposure: 1.0, gamma: 2.2, contrast: 1.1, saturation: 1.2,
  tintR: 1.0, tintG: 1.0, tintB: 1.0
};

let currentState = {
  params: { ...defaultParams },
  presetIndex: 0
};

// Загрузить начальное состояние из первого пресета, если есть
try {
  const presets = readPresetsFromDisk();
  const names = Object.keys(presets);
  if (names.length > 0 && presets[names[0]]) {
    currentState.params = { ...defaultParams, ...presets[names[0]] };
  }
} catch (e) {}

app.get('/api/maximumus-presets', (req, res) => {
  res.json(readPresetsFromDisk());
});

app.post('/api/maximumus-presets', (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  writePresetsToDisk(req.body);
  res.json({ ok: true });
});

app.get('/api/maximumus-state', (req, res) => {
  res.json(currentState);
});

// ——— Призы и лог выигрышей (замена Google Apps Script) ———
app.post('/api/prize', (req, res) => {
  const email = req.body && typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  if (!email || !email.includes('@')) {
    return res.status(400).json({ status: 'error', message: 'Некорректный email' });
  }

  const prizesConfig = readPrizes();
  const wins = readWins();

  // Проверка: этот email уже выигрывал?
  const existing = wins.find(w => (w.email || '').toString().trim().toLowerCase() === email);
  if (existing) {
    const prevPrizeTitle =
      (existing.prize && (existing.prize.title || existing.prize.description)) || '';
    return res.json({
      status: 'error',
      message: prevPrizeTitle
        ? `Вы уже получили свой приз: ${prevPrizeTitle}`
        : 'Вы уже получили свой приз'
    });
  }

  // Считаем, сколько раз каждый PrizeID уже выпал
  const usedCounts = {};
  for (const w of wins) {
    const pid = w.prizeId || (w.prize && w.prize.id);
    if (!pid) continue;
    usedCounts[pid] = (usedCounts[pid] || 0) + 1;
  }

  // Собираем пул доступных призов по аналогии с Apps Script:
  // берём только активные призы с maxCount > usedCount, вес = оставшееся количество
  const availablePrizes = [];
  for (const [prizeId, cfg] of Object.entries(prizesConfig)) {
    if (prizeId === 'default' || prizeId === '*') continue;
    if (!cfg || typeof cfg !== 'object') continue;

    const isActive = normalizeBoolean(cfg.active);
    if (!isActive) continue;

    const maxCount = Number(cfg.maxCount);
    if (!Number.isFinite(maxCount) || maxCount <= 0) continue;

    const alreadyUsed = usedCounts[prizeId] || 0;
    const remaining = maxCount - alreadyUsed;
    if (remaining <= 0) continue;

    availablePrizes.push({
      id: prizeId,
      title: cfg.title || '',
      nominalRub: Number(cfg.nominalRub || 0) || 0,
      rarity: cfg.rarity || '',
      description: cfg.description || '',
      bobry: Number(cfg.bobry || 0) || 0,
      weight: remaining
    });
  }

  if (availablePrizes.length === 0) {
    return res.json({
      status: 'error',
      message: 'Все призы уже разыграны или отключены'
    });
  }

  let totalWeight = 0;
  for (const p of availablePrizes) {
    totalWeight += p.weight;
  }

  let rnd = Math.random() * totalWeight;
  let chosenPrize = availablePrizes[availablePrizes.length - 1];
  for (const p of availablePrizes) {
    rnd -= p.weight;
    if (rnd <= 0) {
      chosenPrize = p;
      break;
    }
  }

  const prizeObj = {
    id: chosenPrize.id,
    title: chosenPrize.title,
    rarity: chosenPrize.rarity,
    nominalRub: chosenPrize.nominalRub,
    description: chosenPrize.description,
    bobry: chosenPrize.bobry
  };

  appendWin({ email, prizeId: chosenPrize.id, prize: prizeObj });

  return res.json({
    status: 'success',
    prize: prizeObj
  });
});

app.post('/api/admin/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD) {
    return res.json({ ok: true, token: 'no-password-set' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  tokenExpiry.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ ok: true, token });
});

app.get('/api/admin/wins', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const wins = readWins().slice(0, limit);
  res.json({ wins });
});

app.get('/api/admin/prizes', requireAdmin, (req, res) => {
  res.json(readPrizes());
});

app.put('/api/admin/prizes', requireAdmin, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  writePrizes(req.body);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws-maximumus' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(currentState));
  ws.on('message', (data) => {
    try {
      const state = JSON.parse(data.toString());
      if (state && state.params && typeof state.params === 'object') {
        currentState.params = { ...currentState.params, ...state.params };
      }
      if (state && state.presetIndex !== undefined) {
        currentState.presetIndex = parseInt(state.presetIndex, 10) || 0;
      }
      const payload = JSON.stringify(currentState);
      clients.forEach(c => {
        if (c.readyState === 1) c.send(payload);
      });
    } catch (e) {
      console.error('WS message error:', e);
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`  Игра (призы): index.html, index-ice-webgl.html, index-ice-procedural.html → POST /api/prize`);
  console.log(`  Админка призов/логов: http://localhost:${PORT}/ice-admin.html`);
  console.log(`  Maximumus: http://localhost:${PORT}/ice-sandbox-maximumus.html`);
  console.log(`  Maximumus Admin: http://localhost:${PORT}/ice-sandbox-maximumus-admin.html`);
});
