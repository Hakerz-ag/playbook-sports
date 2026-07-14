const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple JSON "database" stored in a file — acts like a sheet
const DB_FILE = path.join(__dirname, 'database.json');

// Initialize database file
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      users: [],
      trades: [],
      deposits: [],
      positions: {},
      nextUserId: 1
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Simple session store
const sessions = {};

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  return token;
}

function getSession(token) {
  const session = sessions[token];
  if (!session) return null;
  // Expire after 24 hours
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return null;
  }
  return session;
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html'
}));

// ===== AUTH ROUTES =====

// Sign up
app.post('/api/signup', (req, res) => {
  const { email, phone, password, name } = req.body;
  
  if (!password || password.length < 4) {
    return res.json({ success: false, error: 'Password must be at least 4 characters' });
  }
  
  if (!email && !phone) {
    return res.json({ success: false, error: 'Email or phone number required' });
  }
  
  const db = loadDB();
  
  // Check if user exists
  const existing = db.users.find(u => 
    (email && u.email === email) || (phone && u.phone === phone)
  );
  if (existing) {
    return res.json({ success: false, error: 'Account already exists with this email or phone' });
  }
  
  // Hash password (simple hash for demo)
  const hashedPass = crypto.createHash('sha256').update(password).digest('hex');
  
  const user = {
    id: db.nextUserId++,
    name: name || (email ? email.split('@')[0] : 'User'),
    email: email || '',
    phone: phone || '',
    password: hashedPass,
    balance: 1000.00,
    createdAt: new Date().toISOString()
  };
  
  db.users.push(user);
  saveDB(db);
  
  const token = createSession(user.id);
  
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, balance: user.balance }
  });
});

// Sign in
app.post('/api/signin', (req, res) => {
  const { email, phone, password } = req.body;
  
  if (!password) {
    return res.json({ success: false, error: 'Password required' });
  }
  
  const db = loadDB();
  const hashedPass = crypto.createHash('sha256').update(password).digest('hex');
  
  const user = db.users.find(u => 
    ((email && u.email === email) || (phone && u.phone === phone)) &&
    u.password === hashedPass
  );
  
  if (!user) {
    return res.json({ success: false, error: 'Invalid credentials' });
  }
  
  const token = createSession(user.id);
  
  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, balance: user.balance }
  });
});

// Get current user
app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.json({ success: false, error: 'Not authenticated' });
  
  const db = loadDB();
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.json({ success: false, error: 'User not found' });
  
  // Sync balance from positions/deposits
  let balance = user.balance;
  if (db.deposits) {
    const userDeposits = db.deposits.filter(d => d.userId === user.id);
    // Balance is stored directly, no need to recalculate
  }
  
  res.json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, balance: user.balance }
  });
});

// Sign out
app.post('/api/signout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) delete sessions[token];
  res.json({ success: true });
});

// ===== DEPOSIT =====
app.post('/api/deposit', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.json({ success: false, error: 'Not authenticated' });
  
  const { amount, method } = req.body;
  if (!amount || amount <= 0) return res.json({ success: false, error: 'Invalid amount' });
  
  const db = loadDB();
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.json({ success: false, error: 'User not found' });
  
  user.balance += parseFloat(amount);
  
  if (!db.deposits) db.deposits = [];
  db.deposits.push({
    id: Date.now(),
    userId: user.id,
    amount: parseFloat(amount),
    method: method || 'Card',
    status: 'Completed',
    time: new Date().toLocaleTimeString()
  });
  
  saveDB(db);
  
  res.json({ success: true, balance: user.balance });
});

// ===== TRADES =====
app.post('/api/trade', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.json({ success: false, error: 'Not authenticated' });
  
  const { marketId, marketQuestion, side, shares, price } = req.body;
  
  if (!shares || shares <= 0 || !price || price <= 0 || price > 99) {
    return res.json({ success: false, error: 'Invalid trade parameters' });
  }
  
  const cost = (shares * price) / 100;
  
  const db = loadDB();
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.json({ success: false, error: 'User not found' });
  
  if (cost > user.balance) {
    return res.json({ success: false, error: 'Insufficient balance' });
  }
  
  user.balance -= cost;
  
  if (!db.trades) db.trades = [];
  if (!db.positions) db.positions = {};
  
  const posKey = `${user.id}_${marketId}`;
  if (!db.positions[posKey]) {
    db.positions[posKey] = { userId: user.id, marketId, marketQuestion, side, shares: 0, totalCost: 0 };
  }
  const pos = db.positions[posKey];
  pos.shares += parseInt(shares);
  pos.totalCost += cost;
  pos.avgPrice = (pos.totalCost / pos.shares * 100).toFixed(1);
  
  db.trades.push({
    id: Date.now(),
    userId: user.id,
    marketId,
    marketQuestion,
    side: side.toUpperCase(),
    shares: parseInt(shares),
    price: price + '¢',
    cost: '$' + cost.toFixed(2),
    time: new Date().toLocaleTimeString()
  });
  
  saveDB(db);
  
  res.json({ success: true, balance: user.balance });
});

// ===== GET USER DATA =====
app.get('/api/portfolio', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.json({ success: false, error: 'Not authenticated' });
  
  const db = loadDB();
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.json({ success: false, error: 'User not found' });
  
  const userTrades = (db.trades || []).filter(t => t.userId === user.id);
  const userDeposits = (db.deposits || []).filter(d => d.userId === user.id);
  
  const userPositions = {};
  Object.keys(db.positions || {}).forEach(key => {
    if (db.positions[key].userId === user.id) {
      userPositions[db.positions[key].marketId] = db.positions[key];
    }
  });
  
  res.json({
    success: true,
    balance: user.balance,
    trades: userTrades,
    deposits: userDeposits,
    positions: userPositions
  });
});

// ===== ADMIN: View all users (like a sheet) =====
app.get('/api/admin/users', (req, res) => {
  const db = loadDB();
  const users = db.users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    balance: u.balance,
    createdAt: u.createdAt
  }));
  res.json({ success: true, users });
});

// ===== ESPN API PROXY — Free, no key needed =====

// Sport league mapping
const ESPN_SPORTS = {
  nfl: { path: 'football/nfl', label: 'NFL', icon: '🏈' },
  nba: { path: 'basketball/nba', label: 'NBA', icon: '🏀' },
  mlb: { path: 'baseball/mlb', label: 'MLB', icon: '⚾' },
  nhl: { path: 'hockey/nhl', label: 'NHL', icon: '🏒' },
  epl: { path: 'soccer/eng.1', label: 'EPL', icon: '⚽' },
  la_liga: { path: 'soccer/esp.1', label: 'La Liga', icon: '⚽' },
  mls: { path: 'soccer/usa.1', label: 'MLS', icon: '⚽' },
  f1: { path: 'racing/f1', label: 'F1', icon: '🏎️' },
  atp: { path: 'tennis/atp', label: 'Tennis', icon: '🎾' },
  cfb: { path: 'football/college-football', label: 'CFB', icon: '🏈' },
};

// Convert moneyline odds to implied probability (0-100 cents)
function moneylineToCents(ml) {
  if (!ml) return 50;
  const num = parseInt(ml);
  if (isNaN(num)) return 50;
  if (num > 0) return Math.round(100 / (num + 100) * 100);
  return Math.round(-num / (-num + 100) * 100);
}

// Get live scoreboard for a sport
app.get('/api/sports/:sport/scoreboard', async (req, res) => {
  const sport = ESPN_SPORTS[req.params.sport];
  if (!sport) return res.json({ success: false, error: 'Unknown sport' });

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.path}/scoreboard`);
    const data = await resp.json();

    const games = (data.events || []).map(e => {
      const comp = e.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const odds = comp.odds && comp.odds[0];
      const status = comp.status.type;

      // Build prediction market from the game
      const homeML = odds?.moneyline?.home?.close?.odds;
      const awayML = odds?.moneyline?.away?.close?.odds;
      const homeCents = moneylineToCents(homeML);
      const spread = odds?.details || '';
      const overUnder = odds?.overUnder || '';

      return {
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        date: e.date,
        status: status.name,
        statusDetail: status.shortDetail,
        state: status.state,
        home: {
          name: home?.team.displayName || '',
          abbr: home?.team.abbreviation || '',
          logo: home?.team.logo || '',
          color: home?.team.color || '',
          score: parseInt(home?.score) || 0,
          record: home?.records?.[0]?.summary || '',
          recordType: home?.records?.[0]?.type || '',
        },
        away: {
          name: away?.team.displayName || '',
          abbr: away?.team.abbreviation || '',
          logo: away?.team.logo || '',
          color: away?.team.color || '',
          score: parseInt(away?.score) || 0,
          record: away?.records?.[0]?.summary || '',
          recordType: away?.records?.[0]?.type || '',
        },
        venue: comp.venue?.fullName || '',
        broadcast: comp.broadcasts?.[0]?.names?.[0] || '',
        odds: odds ? {
          spread: spread,
          overUnder: overUnder,
          homeML: homeML || '',
          awayML: awayML || '',
          provider: odds.provider?.name || '',
        } : null,
        // Prediction market prices (implied prob from moneyline)
        homeWinCents: homeCents,
        awayWinCents: 100 - homeCents,
      };
    });

    res.json({ success: true, sport: sport.label, games });
  } catch (err) {
    res.json({ success: false, error: 'Failed to fetch ESPN data' });
  }
});

// Get standings
app.get('/api/sports/:sport/standings', async (req, res) => {
  const sport = ESPN_SPORTS[req.params.sport];
  if (!sport) return res.json({ success: false, error: 'Unknown sport' });

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/v2/sports/${sport.path}/standings`);
    const data = await resp.json();

    const divisions = (data.children || []).map(div => ({
      name: div.name,
      teams: (div.standings?.entries || []).map(entry => {
        const stats = {};
        entry.stats.forEach(s => stats[s.name] = s.displayValue);
        return {
          name: entry.team.displayName,
          abbr: entry.team.abbreviation,
          logo: entry.team.logo,
          wins: stats.wins || '0',
          losses: stats.losses || '0',
          ties: stats.ties || '0',
          pct: stats.winPercent || '',
          seed: stats.playoffSeed || '',
        };
      })
    }));

    res.json({ success: true, sport: sport.label, divisions });
  } catch (err) {
    res.json({ success: false, error: 'Failed to fetch standings' });
  }
});

// Get news
app.get('/api/sports/:sport/news', async (req, res) => {
  const sport = ESPN_SPORTS[req.params.sport];
  if (!sport) return res.json({ success: false, error: 'Unknown sport' });

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.path}/news`);
    const data = await resp.json();
    const articles = (data.articles || []).map(a => ({
      headline: a.headline,
      description: a.description,
      published: a.published,
      link: a.links.web.href,
      image: a.images?.[0]?.url || '',
    }));
    res.json({ success: true, sport: sport.label, articles });
  } catch (err) {
    res.json({ success: false, error: 'Failed to fetch news' });
  }
});

// Get all available sports
app.get('/api/sports', (req, res) => {
  res.json({ success: true, sports: ESPN_SPORTS });
});

// Generate prediction markets from ESPN data
app.get('/api/markets/live', async (req, res) => {
  const allMarkets = [];

  for (const [key, sport] of Object.entries(ESPN_SPORTS)) {
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.path}/scoreboard`);
      const data = await resp.json();

      for (const e of (data.events || []).slice(0, 6)) {
        const comp = e.competitions[0];
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        const odds = comp.odds && comp.odds[0];
        const homeML = odds?.moneyline?.home?.close?.odds;
        const homeCents = moneylineToCents(homeML);

        // Moneyline market: "Will [home team] win?"
        allMarkets.push({
          id: `espn_${key}_${e.id}_ml`,
          cat: key,
          catLabel: sport.label,
          catIcon: sport.icon,
          q: `${home?.team.displayName} vs ${away?.team.displayName} — ${home?.team.displayName} win?`,
          yes: homeCents || 50,
          vol: '$' + (Math.floor(Math.random() * 200) + 20) + 'K',
          timeLeft: comp.status?.type?.shortDetail || e.date,
          desc: `${e.name}. ${odds ? 'Odds via ' + odds.provider?.name + '. Spread: ' + odds.details + '. O/U: ' + odds.overUnder : 'No odds available.'} Game at ${comp.venue?.fullName || 'TBD'}.`,
          homeTeam: home?.team.displayName,
          awayTeam: away?.team.displayName,
          homeLogo: home?.team.logo,
          awayLogo: away?.team.logo,
          homeScore: parseInt(home?.score) || 0,
          awayScore: parseInt(away?.score) || 0,
          status: comp.status?.type?.name || '',
          spread: odds?.details || '',
          overUnder: odds?.overUnder || '',
          date: e.date,
        });

        // Over/Under market if available
        if (odds?.overUnder) {
          const ou = parseFloat(odds.overUnder);
          allMarkets.push({
            id: `espn_${key}_${e.id}_ou`,
            cat: key,
            catLabel: sport.label,
            catIcon: sport.icon,
            q: `${home?.team.abbr} vs ${away?.team.abbr} — Over ${ou}?`,
            yes: 50 + Math.floor(Math.random() * 10 - 5),
            vol: '$' + (Math.floor(Math.random() * 100) + 10) + 'K',
            timeLeft: comp.status?.type?.shortDetail || e.date,
            desc: `Total points over/under ${ou}. ${e.name}.`,
            date: e.date,
          });
        }
      }
    } catch (err) {
      // Skip failed sports
    }
  }

  res.json({ success: true, markets: allMarkets, count: allMarkets.length });
});

app.listen(PORT, () => {
  console.log(`PlayBook server running on http://localhost:${PORT}`);
  console.log(`ESPN API proxy active — free, no key needed`);
});