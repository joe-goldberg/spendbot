// ==========================================================
// SPENDBOT v2 — Crash-proof Backend
// ==========================================================

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

// ── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==========================================================
// ⚙️  CONFIG — Edit nomor WA Anda di sini
// ==========================================================
const MEMBERS = {
  'whatsapp:+6285878894158':  'You',
  'whatsapp:+6281228856391': 'Spouse', 
};

const TARGET_DISCRETIONARY = 500; // Euro
const EXEMPT_CATS = ['Housing', 'Utilities', 'Subscriptions', 'Financial'];
const ALL_CATS = ['Groceries','Transportation','Housing','Utilities','Subscriptions','Lifestyle','Financial','Home Care','Household','Tissue','Other'];

// ==========================================================
// 🗄️  DATABASE — lazy init, no crash if not configured yet
// ==========================================================
let pool = null;
let dbReady = false;

function getPool() {
  if (pool) return pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  return pool;
}

async function initDB() {
  const p = getPool();
  if (!p) {
    console.warn('⚠️  DATABASE_URL not set — running without database');
    return false;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id         SERIAL PRIMARY KEY,
        date       TIMESTAMP NOT NULL DEFAULT NOW(),
        type       VARCHAR(10) NOT NULL DEFAULT 'Expense',
        category   VARCHAR(50) NOT NULL,
        amount     DECIMAL(10,2) NOT NULL,
        notes      TEXT,
        person     VARCHAR(50) DEFAULT 'You',
        wa_number  VARCHAR(50),
        source     VARCHAR(20) DEFAULT 'whatsapp',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
    `);
    dbReady = true;
    console.log('✅ Database ready');
    return true;
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    return false;
  }
}

async function dbQuery(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('Database not configured');
  return p.query(sql, params);
}

// ==========================================================
// 🔧  HELPERS
// ==========================================================
function getPerson(waNum) { return MEMBERS[waNum] || 'You'; }
function fmtE(n)          { return `€${parseFloat(n || 0).toFixed(2)}`; }

function getMonthBounds(offset = 0) {
  const n = new Date();
  const from = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  const to   = new Date(n.getFullYear(), n.getMonth() + offset + 1, 0, 23, 59, 59);
  return { from, to };
}

function detectIntent(txt) {
  const t = (txt || '').toLowerCase().trim();
  if (/^(report|rekap|laporan|summary)(\s|$)/.test(t))      return 'report';
  if (/^(budget|sisa|remaining|limit)(\s|$)/.test(t))       return 'budget';
  if (/^(top|terbesar|biggest)(\s|$)/.test(t))              return 'top';
  if (/^(undo|hapus|delete|cancel|batal)(\s|$)/.test(t))    return 'undo';
  if (/^(help|bantuan|guide)(\s|$)/.test(t))                return 'help';
  if (/^(runrate|run rate|proyeksi)(\s|$)/.test(t))         return 'runrate';
  if (/^(income|salary|gaji|pemasukan)\s+[\d.,]+/.test(t))  return 'income';
  return 'expense';
}

// ==========================================================
// 🧠  CLAUDE API — lazy, never crashes if key missing
// ==========================================================
async function callClaude(messages, system, maxTokens = 500) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

  // Use built-in fetch (Node 18+) — no axios needed
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

async function parseExpenseText(text) {
  const system = `Parse this expense message. Categories: ${ALL_CATS.join(', ')}.
Amounts in Euro. Respond ONLY with JSON (no markdown):
{"amount":12.50,"category":"Groceries","notes":"description"}`;
  try {
    const reply = await callClaude([{ role:'user', content: text }], system);
    return JSON.parse(reply.replace(/```json|```/g,'').trim());
  } catch (e) {
    console.error('Parse error:', e.message);
    return null;
  }
}

async function parseReceiptImage(imageUrl, mimeType) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not set');

  // Download image with Twilio auth
  const auth   = Buffer.from(`${sid}:${token}`).toString('base64');
  const imgRes = await fetch(imageUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);

  const buf    = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buf).toString('base64');
  const mime   = mimeType || 'image/jpeg';

  const system = `You are a receipt scanner. Extract all items.
Categories: ${ALL_CATS.join(', ')}.
Respond ONLY with JSON (no markdown):
{"store":"name","total":25.50,"items":[{"description":"Item","amount":5.00,"category":"Groceries"}]}`;

  const reply = await callClaude([{
    role: 'user',
    content: [
      { type:'image', source:{ type:'base64', media_type: mime, data: base64 } },
      { type:'text',  text: 'Scan this receipt.' }
    ]
  }], system, 1000);

  return JSON.parse(reply.replace(/```json|```/g,'').trim());
}

// ==========================================================
// 📊  REPORT BUILDERS
// ==========================================================
async function buildReport() {
  const { from: cf, to: ct } = getMonthBounds(0);
  const { from: pf, to: pt } = getMonthBounds(-1);
  const now = new Date();

  const [curr, prev, incRow] = await Promise.all([
    dbQuery(`SELECT category, SUM(amount) total, COUNT(*) cnt
             FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
             GROUP BY category ORDER BY total DESC`, [cf, ct]),
    dbQuery(`SELECT category, SUM(amount) total
             FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
             GROUP BY category`, [pf, pt]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) total
             FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cf, ct]),
  ]);

  const prevMap  = Object.fromEntries(prev.rows.map(r => [r.category, +r.total]));
  const totalExp = curr.rows.reduce((s, r) => s + +r.total, 0);
  const income   = +incRow.rows[0].total;

  const lines = curr.rows.map(r => {
    const amt = +r.total;
    const p   = prevMap[r.category] || 0;
    const pct = p ? ((amt - p) / p * 100) : null;
    const arr = pct === null ? '•' : pct > 5 ? '↑' : pct < -5 ? '↓' : '→';
    const ps  = pct !== null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : '';
    return `${arr} ${r.category}: ${fmtE(amt)}${ps}`;
  }).join('\n') || 'No expenses yet';

  const dD  = now.getDate();
  const dM  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const proj = (totalExp / dD) * dM;

  return `📊 *Report — ${now.toLocaleString('default',{month:'long',year:'numeric'})}*\n\n${lines}\n\n──────────────\n💸 Total: *${fmtE(totalExp)}*\n💰 Income: ${income > 0 ? fmtE(income) : 'not set'}\n${income > 0 ? `${totalExp <= income ? '✅':'❌'} Net: *${fmtE(Math.abs(income - totalExp))}* ${income >= totalExp ? 'surplus':'deficit'}\n` : ''}📈 Projected: *${fmtE(proj)}* end-of-month`;
}

async function buildBudgetStatus() {
  const { from, to } = getMonthBounds(0);
  const rows = await dbQuery(`SELECT category, SUM(amount) total
    FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
    GROUP BY category`, [from, to]);
  const totals = Object.fromEntries(rows.rows.map(r => [r.category, +r.total]));
  const disc   = ALL_CATS.filter(c => !EXEMPT_CATS.includes(c)).reduce((s,c) => s + (totals[c]||0), 0);
  const sisa   = TARGET_DISCRETIONARY - disc;
  const pct    = Math.min((disc / TARGET_DISCRETIONARY) * 100, 100);
  const bar    = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  const fixed  = EXEMPT_CATS.map(c => `📌 ${c}: ${fmtE(totals[c]||0)}`).join('\n');
  return `🎯 *Budget Monitor*\n\n*Fixed:*\n${fixed}\n\n*Discretionary (≤€500):*\n${bar} ${pct.toFixed(0)}%\nSpent: *${fmtE(disc)}* / €500\n${sisa >= 0 ? `✅ Remaining: *${fmtE(sisa)}*` : `❌ Over by: *${fmtE(Math.abs(sisa))}*`}`;
}

async function buildRunRate() {
  const { from, to } = getMonthBounds(0);
  const expR = await dbQuery(
    `SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`,
    [from, to]
  );
  const total = +expR.rows[0].t;
  const sisa  = 500 - total;
  return `💸 You've spent *${fmtE(total)}* out of *€500.00* monthly target spend\n${sisa >= 0 ? `✅ *${fmtE(sisa)}* remaining this month` : `⚠️ *${fmtE(Math.abs(sisa))}* over target`}`;
}

async function buildTop() {
  const { from, to } = getMonthBounds(0);
  const rows = await dbQuery(`SELECT notes, category, amount, date, person
    FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
    ORDER BY amount DESC LIMIT 5`, [from, to]);
  if (!rows.rows.length) return '📈 No expenses this month yet.';
  const lines = rows.rows.map((r,i) =>
    `${i+1}. ${r.category} — *${fmtE(r.amount)}*\n   _${r.notes}_ · ${new Date(r.date).toLocaleDateString('en-GB')} · ${r.person}`
  ).join('\n\n');
  return `📈 *Top 5 This Month*\n\n${lines}`;
}

function buildHelp() {
  return `🤖 *SpendBot Guide*

*💸 Record Expense:*
• _"coffee 3.50"_
• _"groceries 45.20 Rimi"_
• _"transport 2 bus"_

*🧾 Scan Receipt:*
Send a photo of any receipt!

*💰 Record Income (each 5th):*
• _"income 4032.40 salary"_

*📊 Reports:*
• _"report"_ — monthly + MoM %
• _"budget"_ — vs €500 target
• _"runrate"_ — projected month-end
• _"top"_ — biggest expenses

*↩️ Undo:* _"undo"_

_Both you & spouse can send to this bot!_`;
}

// ==========================================================
// 💬  HANDLERS
// ==========================================================
async function handleExpense(text, waNum, person) {
  const parsed = await parseExpenseText(text);
  if (!parsed?.amount || parsed.amount <= 0) {
    return `🤔 Could not parse expense.\n\nTry: _"coffee 3.50"_ or _"groceries 45 Rimi"_\nType *help* for all commands.`;
  }

  await dbQuery(
    `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
     VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'whatsapp')`,
    [parsed.category, parsed.amount, parsed.notes, person, waNum]
  );

  const { from, to } = getMonthBounds(0);
  const now = new Date();
  const dD  = now.getDate();
  const dM  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const [totR, discR] = await Promise.all([
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions
             WHERE type='Expense' AND date BETWEEN $1 AND $2 AND NOT (category = ANY($3))`,
             [from, to, EXEMPT_CATS]),
  ]);

  const proj      = (+totR.rows[0].t / dD) * dM;
  const discSpent = +discR.rows[0].t;
  const discSisa  = TARGET_DISCRETIONARY - discSpent;

  let alert = '';
  if (!EXEMPT_CATS.includes(parsed.category)) {
    if      (discSisa < 0)   alert = `\n⚠️ *Discretionary OVER by ${fmtE(Math.abs(discSisa))}!*`;
    else if (discSisa < 100) alert = `\n⚠️ Only *${fmtE(discSisa)}* left of €500 discretionary`;
  }

  return `✅ *Recorded!* (${person})\n\n📂 ${parsed.category}\n💸 *${fmtE(parsed.amount)}*\n📝 ${parsed.notes}\n📅 ${now.toLocaleDateString('en-GB')}\n\n📈 Run rate: *${fmtE(proj)}* projected${alert}\n\n_Photo of receipt? Just send it!_`;
}

async function handleIncome(text, waNum, person) {
  const match = text.match(/[\d.,]+/);
  if (!match) return '❌ Format: _income 4032.40 salary_';
  const amount = parseFloat(match[0].replace(',','.'));
  const notes  = text.replace(/^(income|salary|gaji|pemasukan)\s*/i,'').replace(match[0],'').trim() || 'Salary';

  await dbQuery(
    `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
     VALUES (NOW(),'Income','Income',$1,$2,$3,$4,'whatsapp')`,
    [amount, notes, person, waNum]
  );

  const { from, to } = getMonthBounds(0);
  const expR   = await dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]);
  const spent  = +expR.rows[0].t;
  const sisa   = amount - spent;

  return `✅ *Income recorded!* (${person})\n\n💰 *${fmtE(amount)}* — ${notes}\n📅 ${new Date().toLocaleDateString('en-GB')}\n\n💸 Expenses this month: ${fmtE(spent)}\n${sisa >= 0 ? '✅':'❌'} Net: *${fmtE(Math.abs(sisa))}* ${sisa >= 0 ? 'surplus':'deficit'}`;
}

async function handleUndo(waNum) {
  const row = await dbQuery(
    `SELECT id, category, amount, notes FROM transactions WHERE wa_number=$1 ORDER BY created_at DESC LIMIT 1`,
    [waNum]
  );
  if (!row.rows.length) return '❌ No recent transaction to undo.';
  const tx = row.rows[0];
  await dbQuery(`DELETE FROM transactions WHERE id=$1`, [tx.id]);
  return `🗑️ *Undone!*\n\n${tx.category}: ${fmtE(tx.amount)}\n_${tx.notes}_\n\nRemoved from dashboard.`;
}

// Async receipt — sends follow-up via Twilio REST
async function handleReceiptAsync(imageUrl, mimeType, waNum, person, caption) {
  let msg = '';
  try {
    const scanned = await parseReceiptImage(imageUrl, mimeType);
    if (!scanned?.items?.length) {
      msg = `❌ Could not read the receipt.\n\nTip: Take photo straight-on, good lighting, then resend.`;
    } else {
      const catOverride = ALL_CATS.find(c => caption?.toLowerCase().includes(c.toLowerCase()));

      // Always save EVERY item as a separate transaction (no collapsing)
      let saved = 0;
      for (const item of scanned.items) {
        if (!item.amount || item.amount <= 0) continue;
        await dbQuery(
          `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
           VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'receipt')`,
          [catOverride || item.category || 'Groceries', item.amount, item.description, person, waNum]
        );
        saved++;
      }

      // List ALL items in WA reply
      const allLines = scanned.items
        .filter(i => i.amount > 0)
        .map(i => `• ${i.description}: *${fmtE(i.amount)}*`)
        .join('\n');

      msg = `🧾 *Receipt Scanned!* (${person})\n\n🏪 ${scanned.store || 'Store'}\n\n${allLines}\n\n💸 *Total: ${fmtE(scanned.total)}*\n✅ ${saved} item${saved>1?'s':''} saved to dashboard!`;
    }
  } catch (err) {
    msg = `❌ Receipt scan failed: ${err.message}`;
  }

  // Send follow-up via Twilio REST API
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return;

  const body = new URLSearchParams({ From:'whatsapp:+14155238886', To: waNum, Body: msg });
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}

// ==========================================================
// 📱  WEBHOOK
// ==========================================================
app.post('/webhook', async (req, res) => {
  const body      = req.body || {};
  const text      = (body.Body || '').trim();
  const waNum     = body.From || 'unknown';
  const numMedia  = parseInt(body.NumMedia || '0');
  const mediaUrl  = body.MediaUrl0 || null;
  const mediaType = body.MediaContentType0 || 'image/jpeg';
  const person    = getPerson(waNum);

  console.log(`[WA] ${person} | media:${numMedia} | "${text}"`);

  // Helper to send TwiML response
  const twiml = (msg) => {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${msg}]]></Message></Response>`);
  };

  // Check DB available
  if (!dbReady) {
    twiml('⚠️ Bot is starting up, please try again in 30 seconds.');
    return;
  }

  try {
    // Receipt photo
    if (numMedia > 0 && mediaUrl && mediaType.startsWith('image/')) {
      twiml('⏳ Scanning receipt... (~10 seconds)');
      handleReceiptAsync(mediaUrl, mediaType, waNum, person, text).catch(console.error);
      return;
    }

    // Text commands
    let reply = '';
    switch (detectIntent(text)) {
      case 'report':   reply = await buildReport(); break;
      case 'budget':   reply = await buildBudgetStatus(); break;
      case 'runrate':  reply = await buildRunRate(); break;
      case 'top':      reply = await buildTop(); break;
      case 'undo':     reply = await handleUndo(waNum); break;
      case 'help':     reply = buildHelp(); break;
      case 'income':   reply = await handleIncome(text, waNum, person); break;
      case 'expense':  reply = await handleExpense(text, waNum, person); break;
      default:         reply = buildHelp();
    }
    twiml(reply);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    twiml(`⚠️ Error: ${err.message}\n\nType *help* for guidance.`);
  }
});

// ==========================================================
// 🌐  API ENDPOINTS
// ==========================================================
app.get('/api/stats', async (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'Database not ready' });
  try {
    const now  = new Date();
    const cf   = new Date(now.getFullYear(), now.getMonth(), 1);
    const ct   = now;
    const pf   = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pt   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [curr, prev, ci, pi, recent] = await Promise.all([
      dbQuery(`SELECT category, SUM(amount) total, COUNT(*) cnt
        FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
        GROUP BY category ORDER BY total DESC`, [cf, ct]),
      dbQuery(`SELECT category, SUM(amount) total
        FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
        GROUP BY category`, [pf, pt]),
      dbQuery(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cf, ct]),
      dbQuery(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [pf, pt]),
      dbQuery(`SELECT * FROM transactions ORDER BY date DESC LIMIT 30`),
    ]);

    const currTotal = curr.rows.reduce((s,r) => s + +r.total, 0);
    const prevTotal = prev.rows.reduce((s,r) => s + +r.total, 0);
    const income    = +ci.rows[0].total;
    const prevMap   = Object.fromEntries(prev.rows.map(r => [r.category, +r.total]));
    const dD = now.getDate();
    const dM = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    res.json({
      success: true,
      current: {
        from: cf, to: ct,
        totalExpense: currTotal,
        totalIncome: income,
        balance: income - currTotal,
        transactionCount: curr.rows.reduce((s,r) => s + +r.cnt, 0),
        byCategory: curr.rows.map(r => ({
          category: r.category,
          total: +r.total,
          count: +r.cnt,
          prevTotal: prevMap[r.category] || 0,
          growth: prevMap[r.category] ? ((+r.total - prevMap[r.category]) / prevMap[r.category] * 100) : null,
        })),
        runRate: currTotal > 0 ? (currTotal / dD) * dM : 0,
        daysElapsed: dD,
        daysInMonth: dM,
      },
      previous: { from: pf, to: pt, totalExpense: prevTotal, totalIncome: +pi.rows[0].total },
      recent: recent.rows,
      config: { targetDiscretionary: TARGET_DISCRETIONARY, exemptCategories: EXEMPT_CATS },
    });
  } catch (err) {
    console.error('[/api/stats]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'Database not ready' });
  try {
    const { from, to, type, category, person, limit = 1000 } = req.query;
    let where = ['1=1'], params = [], i = 1;
    if (from)     { where.push(`date >= $${i++}`); params.push(from); }
    if (to)       { where.push(`date <= $${i++}`); params.push(to); }
    if (type)     { where.push(`type = $${i++}`); params.push(type); }
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (person)   { where.push(`person = $${i++}`); params.push(person); }
    const rows = await dbQuery(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT $${i}`,
      [...params, +limit]
    );
    res.json({ success: true, count: rows.rowCount, data: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/import', async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, error: 'Database not ready' });
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ success: false, error: 'rows[] required' });
    let inserted = 0;
    for (const row of rows) {
      if (!row.date || !row.category) continue;
      const amt = parseFloat((row.amount || '0').toString().replace(/,/g,''));
      if (isNaN(amt)) continue;
      await dbQuery(
        `INSERT INTO transactions (date,type,category,amount,notes,person,source)
         VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [new Date(row.date), row.type || 'Expense', row.category, amt, row.notes || '', row.person || 'You']
      );
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, error: 'Database not ready' });
  try {
    await dbQuery(`DELETE FROM transactions WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check — always responds 200, never crashes
app.get('/', (req, res) => {
  res.json({
    status: '🤖 SpendBot v2',
    db: dbReady ? '✅ connected' : '⚠️ not ready',
    ai: process.env.ANTHROPIC_API_KEY ? '✅ configured' : '⚠️ not set',
    twilio: process.env.TWILIO_ACCOUNT_SID ? '✅ configured' : '⚠️ not set',
    uptime: process.uptime().toFixed(0) + 's',
  });
});

// ==========================================================
// 🚀  START — never exits on DB failure
// ==========================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🤖 SpendBot v2 listening on port ${PORT}`);
  // Init DB in background — server is already accepting requests
  initDB().catch(err => console.error('DB init failed:', err.message));
});

// Prevent crash on unhandled promise rejection
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
