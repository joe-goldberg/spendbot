// ==========================================================
// SPENDBOT v2 — Full Backend
// Features: PostgreSQL, Claude Vision OCR, Multi-user,
//           Income tracking, Run rate, Euro amounts
// ==========================================================

const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

// ── CORS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==========================================================
// ⚙️  CONFIGURATION
// ==========================================================
const CONFIG = {
  // !! EDIT NOMOR WA ANDA DI SINI !!
  // Format: 'whatsapp:+[kode negara][nomor]'
  // Contoh Estonia: 'whatsapp:+3725xxxxxxx'
  MEMBERS: {
    'whatsapp:+6285878894158':  'You',
    'whatsapp:+6281224803690': 'Spouse',
  },

  TARGET_DISCRETIONARY: 500,
  EXEMPT_CATEGORIES: ['Housing', 'Utilities', 'Subscriptions', 'Financial'],
  CATEGORIES: [
    'Groceries', 'Transportation', 'Housing', 'Utilities',
    'Subscriptions', 'Lifestyle', 'Financial', 'Home Care',
    'Household', 'Tissue', 'Other'
  ],

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  DATABASE_URL:      process.env.DATABASE_URL || '',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN:  process.env.TWILIO_AUTH_TOKEN || '',
};

// ==========================================================
// 🗄️  DATABASE — PostgreSQL via Railway
// ==========================================================
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: CONFIG.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      date        TIMESTAMP NOT NULL DEFAULT NOW(),
      type        VARCHAR(10) NOT NULL DEFAULT 'Expense',
      category    VARCHAR(50) NOT NULL,
      amount      DECIMAL(10,2) NOT NULL,
      notes       TEXT,
      person      VARCHAR(50) DEFAULT 'You',
      wa_number   VARCHAR(50),
      source      VARCHAR(20) DEFAULT 'whatsapp',
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  `);
  console.log('✅ Database ready');
}

// ==========================================================
// 🔧  HELPERS
// ==========================================================
function getPerson(waNumber) {
  return CONFIG.MEMBERS[waNumber] || 'You';
}
function fmtEuro(n) { return `€${parseFloat(n||0).toFixed(2)}`; }
function getMonthRange(offset = 0) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to   = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59);
  return { from, to };
}
function detectIntent(text) {
  const t = text.toLowerCase().trim();
  if (/^(report|rekap|laporan|summary|ringkasan)(\s|$)/.test(t)) return 'report';
  if (/^(budget|sisa|remaining|limit)(\s|$)/.test(t))            return 'budget';
  if (/^(top|terbesar|biggest)(\s|$)/.test(t))                   return 'top';
  if (/^(undo|hapus|delete|cancel|batal)(\s|$)/.test(t))         return 'undo';
  if (/^(help|bantuan|guide)(\s|$)/.test(t))                     return 'help';
  if (/^(runrate|run rate|proyeksi)(\s|$)/.test(t))              return 'runrate';
  if (/^(income|salary|gaji|pemasukan)\s+[\d.,]+/.test(t))       return 'income';
  return 'expense';
}

// ==========================================================
// 🧠  CLAUDE AI CALLS
// ==========================================================
async function callClaude(messages, system, maxTokens = 500) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system,
    messages,
  }, {
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });
  return res.data.content[0].text;
}

// Parse expense text with Claude
async function parseExpenseText(text) {
  const system = `You parse expense messages into structured data.
Categories: ${CONFIG.CATEGORIES.join(', ')}.
Amounts are in Euro unless stated otherwise.
Respond ONLY with JSON (no markdown):
{"amount": 12.50, "category": "Groceries", "notes": "Coffee and croissant"}`;

  try {
    const reply = await callClaude([{ role: 'user', content: text }], system);
    return JSON.parse(reply.replace(/```json|```/g, '').trim());
  } catch { return null; }
}

// OCR receipt image with Claude Vision
async function parseReceiptImage(imageUrl, mimeType) {
  const system = `You are a receipt scanner. Extract all items from this receipt.
Categories: ${CONFIG.CATEGORIES.join(', ')}.
Respond ONLY with JSON (no markdown):
{"store":"Store name","total":25.50,"items":[{"description":"Item","amount":5.00,"category":"Groceries"}]}`;

  // Download image (Twilio requires auth)
  const imgRes = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    auth: { username: CONFIG.TWILIO_ACCOUNT_SID, password: CONFIG.TWILIO_AUTH_TOKEN }
  });
  const base64 = Buffer.from(imgRes.data).toString('base64');

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
      { type: 'text', text: 'Scan this receipt and extract all items.' }
    ]
  }];

  try {
    const reply = await callClaude(messages, system, 1000);
    return JSON.parse(reply.replace(/```json|```/g, '').trim());
  } catch { return null; }
}

// ==========================================================
// 📊  REPORT BUILDERS
// ==========================================================
async function buildReport() {
  const { from: cFrom, to: cTo } = getMonthRange(0);
  const { from: pFrom, to: pTo } = getMonthRange(-1);
  const now = new Date();

  const [curr, prev, incRow] = await Promise.all([
    pool.query(`SELECT category, SUM(amount) as total, COUNT(*) as cnt
      FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
      GROUP BY category ORDER BY total DESC`, [cFrom, cTo]),
    pool.query(`SELECT category, SUM(amount) as total
      FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
      GROUP BY category`, [pFrom, pTo]),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions
      WHERE type='Income' AND date BETWEEN $1 AND $2`, [cFrom, cTo]),
  ]);

  const prevMap = Object.fromEntries(prev.rows.map(r => [r.category, parseFloat(r.total)]));
  const totalExp = curr.rows.reduce((s, r) => s + parseFloat(r.total), 0);
  const income = parseFloat(incRow.rows[0].total);

  const lines = curr.rows.map(r => {
    const amt = parseFloat(r.total);
    const p = prevMap[r.category] || 0;
    const pctChange = p ? ((amt - p) / p * 100) : null;
    const arrow = pctChange === null ? '•' : pctChange > 5 ? '↑' : pctChange < -5 ? '↓' : '→';
    const pctStr = pctChange !== null ? ` (${pctChange > 0 ? '+' : ''}${pctChange.toFixed(0)}%)` : '';
    return `${arrow} ${r.category}: ${fmtEuro(amt)}${pctStr}`;
  }).join('\n');

  const dDay = now.getDate();
  const dMon = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const projected = (totalExp / dDay) * dMon;

  return `📊 *Report — ${now.toLocaleString('default',{month:'long',year:'numeric'})}*\n\n${lines||'No expenses yet'}\n\n──────────────────\n💸 Total: *${fmtEuro(totalExp)}*\n💰 Income: ${income > 0 ? fmtEuro(income) : 'not set'}\n${income > 0 ? `${totalExp<=income?'✅':'❌'} Net: *${fmtEuro(Math.abs(income-totalExp))}* ${income>=totalExp?'surplus':'deficit'}\n` : ''}📈 Projected: *${fmtEuro(projected)}* end-of-month`;
}

async function buildBudgetStatus() {
  const { from, to } = getMonthRange(0);
  const rows = await pool.query(`SELECT category, SUM(amount) as total
    FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
    GROUP BY category`, [from, to]);
  const totals = Object.fromEntries(rows.rows.map(r => [r.category, parseFloat(r.total)]));
  const disc = CONFIG.CATEGORIES.filter(c => !CONFIG.EXEMPT_CATEGORIES.includes(c))
    .reduce((s,c) => s + (totals[c]||0), 0);
  const sisa = CONFIG.TARGET_DISCRETIONARY - disc;
  const pct = Math.min((disc / CONFIG.TARGET_DISCRETIONARY) * 100, 100);
  const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10));
  const fixedLines = CONFIG.EXEMPT_CATEGORIES.map(c => `📌 ${c}: ${fmtEuro(totals[c]||0)}`).join('\n');
  return `🎯 *Budget Monitor*\n\n*Fixed:*\n${fixedLines}\n\n*Discretionary (≤€500):*\n${bar} ${pct.toFixed(0)}%\nSpent: *${fmtEuro(disc)}* / €500\n${sisa>=0?`✅ Remaining: *${fmtEuro(sisa)}*`:`❌ Over by: *${fmtEuro(Math.abs(sisa))}*`}`;
}

async function buildRunRate() {
  const { from, to } = getMonthRange(0);
  const now = new Date();
  const dDay = now.getDate();
  const dMon = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const [expRow, incRow] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [from, to]),
  ]);
  const total = parseFloat(expRow.rows[0].t);
  const income = parseFloat(incRow.rows[0].t);
  const daily = total / dDay;
  const projected = daily * dMon;
  return `📈 *Run Rate — ${now.toLocaleString('default',{month:'long'})}*\n\n📅 Day ${dDay} of ${dMon}\n💸 Spent so far: *${fmtEuro(total)}*\n📊 Daily avg: *${fmtEuro(daily)}*\n🔮 Projected: *${fmtEuro(projected)}*\n${income>0?`💰 Income: ${fmtEuro(income)}\n${projected<=income?'✅':'❌'} Projected ${projected<=income?'within':'OVER'} income`:'⚠️ No income set — send: _income 4000 salary_'}`;
}

async function buildTop() {
  const { from, to } = getMonthRange(0);
  const rows = await pool.query(`SELECT notes, category, amount, date, person
    FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
    ORDER BY amount DESC LIMIT 5`, [from, to]);
  if (!rows.rows.length) return '📈 No expenses this month yet.';
  const lines = rows.rows.map((r,i) =>
    `${i+1}. ${r.category} — *${fmtEuro(r.amount)}*\n   _${r.notes}_ · ${new Date(r.date).toLocaleDateString('en-GB')} · ${r.person}`
  ).join('\n\n');
  return `📈 *Top 5 This Month*\n\n${lines}`;
}

function buildHelp() {
  return `🤖 *SpendBot Guide*

*💸 Record Expense:*
Just type amount + description:
• _"coffee 3.50"_
• _"groceries 45.20 Rimi"_
• _"transport 2 bus"_

*🧾 Scan Receipt:*
Send a photo of receipt → auto-scanned!

*💰 Record Income (each 5th):*
• _"income 4032.40 salary"_

*📊 Reports:*
• _"report"_ — monthly summary + MoM %
• _"budget"_ — vs €500 target
• _"runrate"_ — projected month-end
• _"top"_ — biggest expenses

*↩️ Undo:*
• _"undo"_ — remove last entry

*👥 Multi-user:* Both you & spouse can send!`;
}

// ==========================================================
// 📱  WEBHOOK
// ==========================================================
app.post('/webhook', async (req, res) => {
  const body      = req.body;
  const text      = (body.Body || '').trim();
  const waNumber  = body.From || 'unknown';
  const numMedia  = parseInt(body.NumMedia || '0');
  const mediaUrl  = body.MediaUrl0 || null;
  const mediaType = body.MediaContentType0 || 'image/jpeg';
  const person    = getPerson(waNumber);

  console.log(`[WA] ${person} (${waNumber}): "${text}" | media: ${numMedia}`);

  let reply = '';
  try {
    // ── Receipt photo ─────────────────────────────────────
    if (numMedia > 0 && mediaUrl && mediaType.startsWith('image/')) {
      reply = '⏳ Scanning receipt... this takes ~10 seconds.';
      // Send immediate ack, then process async
      const twimlAck = `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${reply}]]></Message></Response>`;
      res.set('Content-Type', 'text/xml');
      res.send(twimlAck);

      // Process receipt and send follow-up via Twilio REST API
      handleReceiptAsync(mediaUrl, mediaType, waNumber, person, text);
      return;
    }

    // ── Text commands ─────────────────────────────────────
    switch (detectIntent(text)) {
      case 'report':   reply = await buildReport(); break;
      case 'budget':   reply = await buildBudgetStatus(); break;
      case 'runrate':  reply = await buildRunRate(); break;
      case 'top':      reply = await buildTop(); break;
      case 'undo':     reply = await handleUndo(waNumber); break;
      case 'help':     reply = buildHelp(); break;
      case 'income':   reply = await handleIncome(text, waNumber, person); break;
      case 'expense':  reply = await handleExpense(text, waNumber, person); break;
      default:         reply = buildHelp();
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    reply = `⚠️ Error: ${err.message}\n\nType *help* for guidance.`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${reply}]]></Message></Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ==========================================================
// 🔄  ASYNC RECEIPT HANDLER (sends follow-up WA message)
// ==========================================================
async function handleReceiptAsync(imageUrl, mimeType, waNumber, person, caption) {
  try {
    const scanned = await parseReceiptImage(imageUrl, mimeType);
    let replyMsg = '';

    if (!scanned || !scanned.items?.length) {
      replyMsg = `❌ Could not read the receipt clearly.\n\nTip: Take photo straight-on with good lighting, then resend.`;
    } else {
      const catOverride = CONFIG.CATEGORIES.find(c =>
        caption && caption.toLowerCase().includes(c.toLowerCase())
      );

      // Save as single total or per-item
      if (scanned.items.length > 5) {
        const cat = catOverride || 'Groceries';
        await pool.query(
          `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
           VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'receipt')`,
          [cat, scanned.total, `${scanned.store || 'Store'} receipt`, person, waNumber]
        );
      } else {
        for (const item of scanned.items) {
          if (!item.amount || item.amount <= 0) continue;
          await pool.query(
            `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
             VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'receipt')`,
            [catOverride || item.category || 'Groceries', item.amount, item.description, person, waNumber]
          );
        }
      }

      const itemLines = scanned.items.slice(0,5).map(i => `• ${i.description}: ${fmtEuro(i.amount)}`).join('\n');
      replyMsg = `🧾 *Receipt Scanned!* (${person})\n\n🏪 ${scanned.store || 'Store'}\n\n${itemLines}${scanned.items.length>5?`\n_...${scanned.items.length-5} more items_`:''}\n\n💸 *Total: ${fmtEuro(scanned.total)}*\n✅ Saved to dashboard!`;
    }

    // Send follow-up via Twilio REST API
    await sendWhatsApp(waNumber, replyMsg);
  } catch (err) {
    console.error('[RECEIPT ERROR]', err.message);
    await sendWhatsApp(waNumber, `❌ Receipt scan failed: ${err.message}`);
  }
}

async function sendWhatsApp(to, body) {
  if (!CONFIG.TWILIO_ACCOUNT_SID) return;
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({
      From: 'whatsapp:+14155238886',
      To: to,
      Body: body,
    }),
    { auth: { username: CONFIG.TWILIO_ACCOUNT_SID, password: CONFIG.TWILIO_AUTH_TOKEN } }
  );
}

// ==========================================================
// 💬  EXPENSE & INCOME HANDLERS
// ==========================================================
async function handleExpense(text, waNumber, person) {
  const parsed = await parseExpenseText(text);
  if (!parsed?.amount || parsed.amount <= 0) {
    return `🤔 Could not parse expense.\n\nTry: _"coffee 3.50"_ or _"groceries 45 Rimi"_\nType *help* for all commands.`;
  }

  await pool.query(
    `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
     VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'whatsapp')`,
    [parsed.category, parsed.amount, parsed.notes, person, waNumber]
  );

  // Run rate for current month
  const { from, to } = getMonthRange(0);
  const now = new Date();
  const dDay = now.getDate();
  const dMon = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const [totRow, discRow] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0) as t FROM transactions
       WHERE type='Expense' AND date BETWEEN $1 AND $2
       AND category != ALL($3)`,
      [from, to, CONFIG.EXEMPT_CATEGORIES]
    ),
  ]);
  const monthTotal = parseFloat(totRow.rows[0].t);
  const discTotal  = parseFloat(discRow.rows[0].t);
  const projected  = (monthTotal / dDay) * dMon;
  const discSisa   = CONFIG.TARGET_DISCRETIONARY - discTotal;

  let budgetAlert = '';
  if (!CONFIG.EXEMPT_CATEGORIES.includes(parsed.category)) {
    if (discSisa < 0) {
      budgetAlert = `\n⚠️ *Discretionary OVER by ${fmtEuro(Math.abs(discSisa))}!*`;
    } else if (discSisa < 100) {
      budgetAlert = `\n⚠️ Only *${fmtEuro(discSisa)}* left of €500 discretionary`;
    }
  }

  return `✅ *Recorded!* (${person})\n\n📂 ${parsed.category}\n💸 *${fmtEuro(parsed.amount)}*\n📝 ${parsed.notes}\n📅 ${now.toLocaleDateString('en-GB')}\n\n📈 Run rate: *${fmtEuro(projected)}* projected this month${budgetAlert}\n\n_Photo of receipt? Just send it!_`;
}

async function handleIncome(text, waNumber, person) {
  const match = text.match(/[\d.,]+/);
  if (!match) return '❌ Format: _income 4032.40 salary_';
  const amount = parseFloat(match[0].replace(',', '.'));
  const notes  = text.replace(/^(income|salary|gaji|pemasukan)\s*/i, '').replace(match[0], '').trim() || 'Salary';

  await pool.query(
    `INSERT INTO transactions (date,type,category,amount,notes,person,wa_number,source)
     VALUES (NOW(),'Income','Income',$1,$2,$3,$4,'whatsapp')`,
    [amount, notes, person, waNumber]
  );

  const { from, to } = getMonthRange(0);
  const expRow = await pool.query(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`,
    [from, to]
  );
  const totalExp = parseFloat(expRow.rows[0].t);
  const sisa     = amount - totalExp;

  return `✅ *Income recorded!* (${person})\n\n💰 *${fmtEuro(amount)}* — ${notes}\n📅 ${new Date().toLocaleDateString('en-GB')}\n\n💸 Expenses this month: ${fmtEuro(totalExp)}\n${sisa>=0?'✅':'❌'} Net: *${fmtEuro(Math.abs(sisa))}* ${sisa>=0?'surplus':'deficit'}`;
}

async function handleUndo(waNumber) {
  const row = await pool.query(
    `SELECT id, category, amount, notes FROM transactions WHERE wa_number=$1 ORDER BY created_at DESC LIMIT 1`,
    [waNumber]
  );
  if (!row.rows.length) return '❌ No recent transaction to undo.';
  const tx = row.rows[0];
  await pool.query(`DELETE FROM transactions WHERE id=$1`, [tx.id]);
  return `🗑️ *Undone!*\n\n${tx.category}: ${fmtEuro(tx.amount)}\n_${tx.notes}_\n\nRemoved from dashboard.`;
}

// ==========================================================
// 🌐  DASHBOARD API ENDPOINTS
// ==========================================================
app.get('/api/stats', async (req, res) => {
  try {
    const now    = new Date();
    const cFrom  = new Date(now.getFullYear(), now.getMonth(), 1);
    const cTo    = now;
    const pFrom  = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const pTo    = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [curr, prev, currInc, prevInc, recent] = await Promise.all([
      pool.query(`SELECT category, SUM(amount) as total, COUNT(*) as count
        FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
        GROUP BY category ORDER BY total DESC`, [cFrom, cTo]),
      pool.query(`SELECT category, SUM(amount) as total
        FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2
        GROUP BY category`, [pFrom, pTo]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cFrom, cTo]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [pFrom, pTo]),
      pool.query(`SELECT * FROM transactions ORDER BY date DESC LIMIT 30`),
    ]);

    const currTotal = curr.rows.reduce((s,r) => s + parseFloat(r.total), 0);
    const prevTotal = prev.rows.reduce((s,r) => s + parseFloat(r.total), 0);
    const income    = parseFloat(currInc.rows[0].total);
    const prevMap   = Object.fromEntries(prev.rows.map(r => [r.category, parseFloat(r.total)]));
    const dDay      = now.getDate();
    const dMon      = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();

    res.json({
      success: true,
      current: {
        from: cFrom, to: cTo,
        totalExpense: currTotal,
        totalIncome: income,
        balance: income - currTotal,
        transactionCount: curr.rows.reduce((s,r)=>s+parseInt(r.count),0),
        byCategory: curr.rows.map(r => ({
          category: r.category,
          total: parseFloat(r.total),
          count: parseInt(r.count),
          prevTotal: prevMap[r.category] || 0,
          growth: prevMap[r.category] ? ((parseFloat(r.total)-prevMap[r.category])/prevMap[r.category]*100) : null,
        })),
        runRate: (currTotal / dDay) * dMon,
        daysElapsed: dDay,
        daysInMonth: dMon,
      },
      previous: {
        from: pFrom, to: pTo,
        totalExpense: prevTotal,
        totalIncome: parseFloat(prevInc.rows[0].total),
      },
      recent: recent.rows,
      config: {
        targetDiscretionary: CONFIG.TARGET_DISCRETIONARY,
        exemptCategories: CONFIG.EXEMPT_CATEGORIES,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const { from, to, type, category, person, limit = 1000 } = req.query;
    let where = ['1=1'], params = [], i = 1;
    if (from)     { where.push(`date >= $${i++}`); params.push(from); }
    if (to)       { where.push(`date <= $${i++}`); params.push(to); }
    if (type)     { where.push(`type = $${i++}`); params.push(type); }
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (person)   { where.push(`person = $${i++}`); params.push(person); }
    const rows = await pool.query(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT $${i}`,
      [...params, limit]
    );
    res.json({ success: true, count: rows.rowCount, data: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Import historical data from CSV
app.post('/api/import', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ success: false, error: 'rows[] required' });
    let inserted = 0;
    for (const row of rows) {
      if (!row.date || !row.amount || !row.category) continue;
      await pool.query(
        `INSERT INTO transactions (date,type,category,amount,notes,person,source)
         VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [new Date(row.date), row.type||'Expense', row.category, parseFloat(row.amount), row.notes||'', row.person||'You']
      );
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM transactions WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: '🤖 SpendBot v2',
    db: !!CONFIG.DATABASE_URL,
    ai: !!CONFIG.ANTHROPIC_API_KEY,
  });
});

// ==========================================================
// 🚀  START
// ==========================================================
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`\n🤖 SpendBot v2 running on port ${PORT}\n`));
}).catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
