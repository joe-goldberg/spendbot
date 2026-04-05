// ==========================================================
// SPENDBOT v3 — Full Telegram + All Features
// ==========================================================

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==========================================================
// ⚙️  CONFIG
// ==========================================================
// MEMBERS: map Telegram chat_id (string) → display name
// Fill these after getting Chat IDs from /getUpdates
const MEMBERS = {
  'TELEGRAM_CHAT_ID_YOU':     'You',
  'TELEGRAM_CHAT_ID_SPOUSE':  'Spouse',
};

// All known Telegram Chat IDs (for broadcasts)
function getAllChatIds() {
  return Object.keys(MEMBERS).filter(id => !id.startsWith('TELEGRAM_'));
}

const TARGET_DISCRETIONARY = 500; // Euro
const EXEMPT_CATS = ['Housing', 'Utilities', 'Subscriptions', 'Financial'];
const ALL_CATS = ['Groceries','Transportation','Housing','Utilities','Subscriptions','Lifestyle','Financial','Home Care','Household','Other'];
const TIMEZONE_OFFSET = 3; // EET/EEST (Estonia) — UTC+3 in summer, adjust to 2 in winter

// ==========================================================
// 🗄️  DATABASE
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
  if (!p) { console.warn('⚠️  DATABASE_URL not set'); return false; }
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
        chat_id    VARCHAR(50),
        source     VARCHAR(20) DEFAULT 'telegram',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);

      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        category    VARCHAR(50) NOT NULL,
        amount      DECIMAL(10,2) NOT NULL,
        notes       TEXT,
        person      VARCHAR(50) DEFAULT 'You',
        days_of_week VARCHAR(20) DEFAULT '1,2,3,4,5',
        active      BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id       SERIAL PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        amount   DECIMAL(10,2) NOT NULL,
        month    VARCHAR(7) NOT NULL,
        UNIQUE(category, month)
      );

      CREATE TABLE IF NOT EXISTS user_streaks (
        chat_id       VARCHAR(50) PRIMARY KEY,
        current_streak INT DEFAULT 0,
        longest_streak INT DEFAULT 0,
        last_input_date DATE
      );

      CREATE TABLE IF NOT EXISTS notifications_log (
        id        SERIAL PRIMARY KEY,
        type      VARCHAR(50) NOT NULL,
        sent_at   TIMESTAMP DEFAULT NOW(),
        chat_id   VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY,
        data TEXT NOT NULL,
        person VARCHAR(50),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Migration: safely add new columns to existing tables
    await p.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS chat_id VARCHAR(50);
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'telegram';
    `);
    dbReady = true;
    console.log('✅ Database ready (v3)');
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
// 📬  TELEGRAM
// ==========================================================
async function tgSend(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn('TELEGRAM_BOT_TOKEN not set'); return; }
  const chatIds = Array.isArray(chatId) ? chatId : [chatId];
  for (const id of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'Markdown', ...extra }),
      });
    } catch (e) {
      console.error(`Telegram send error to ${id}:`, e.message);
    }
  }
}

async function tgBroadcast(text) {
  const ids = getAllChatIds();
  if (!ids.length) { console.warn('No Telegram Chat IDs configured yet'); return; }
  await tgSend(ids, text);
}

async function tgSendPhoto(chatId, imageBuffer, mimeType, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  // For receipt scanning we re-use the buffer approach
  const { FormData, Blob } = await import('node:buffer').catch(() => ({ FormData: global.FormData, Blob: global.Blob }));
  // Fallback: just send caption as text if photo sending is complex
  await tgSend(chatId, caption || '📸 Photo received');
}

// ==========================================================
// 🔧  HELPERS
// ==========================================================
function getPerson(chatId) { return MEMBERS[String(chatId)] || 'You'; }
function fmtE(n) { return `€${parseFloat(n || 0).toFixed(2)}`; }

function getMonthBounds(offset = 0) {
  const n = new Date();
  const from = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  const to   = new Date(n.getFullYear(), n.getMonth() + offset + 1, 0, 23, 59, 59);
  return { from, to };
}

function localNow() {
  // Returns current time adjusted to configured timezone
  const now = new Date();
  now.setHours(now.getHours() + TIMEZONE_OFFSET);
  return now;
}

function detectIntent(txt) {
  const t = (txt || '').toLowerCase().trim();
  if (/^(\/start|start)$/.test(t))                                return 'start';
  if (/^(report|rekap|laporan|summary)(\s|$)/.test(t))           return 'report';
  if (/^(budget|sisa|remaining|limit)(\s|$)/.test(t))            return 'budget';
  if (/^(top|terbesar|biggest)(\s|$)/.test(t))                   return 'top';
  if (/^(undo|hapus|delete|cancel|batal)(\s|$)/.test(t))         return 'undo';
  if (/^(help|bantuan|guide|\/help)(\s|$)/.test(t))              return 'help';
  if (/^(runrate|run rate|proyeksi)(\s|$)/.test(t))              return 'runrate';
  if (/^(income|salary|gaji|pemasukan)\s+[\d.,]+/.test(t))       return 'income';
  if (/^(invest|investment|portfolio)\s*(update|list|show)?(\s|$)/.test(t)) return 'invest';
  if (/^(weekly|mingguan)(\s|$)/.test(t))                        return 'weekly';
  if (/^(monthly|bulanan)(\s|$)/.test(t))                        return 'monthly';
  if (/^(streak|skor|score)(\s|$)/.test(t))                      return 'streak';
  if (/^(recurring|rutin|otomatis)(\s|$)/.test(t))               return 'recurring';
  if (/^(setbudget|set budget)\s+\w/.test(t))                    return 'setbudget';
  if (/^(export|unduh|download)(\s|$)/.test(t))                  return 'export';
  return 'expense';
}

// ==========================================================
// 🧠  CLAUDE API
// ==========================================================
async function callClaude(messages, system, maxTokens = 600) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

async function parseExpenseText(text) {
  const system = `Parse this expense message. Categories: ${ALL_CATS.join(', ')}.
Amounts in Euro. Respond ONLY with JSON (no markdown):
{"amount":12.50,"category":"Groceries","notes":"brief description"}`;
  try {
    const reply = await callClaude([{ role: 'user', content: text }], system);
    return JSON.parse(reply.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('parseExpenseText error:', e.message);
    return null;
  }
}

async function parseReceiptImage(imageBase64, mimeType) {
  const system = `You are a receipt scanner. Extract all items.
Categories: ${ALL_CATS.join(', ')}.
Respond ONLY with JSON (no markdown):
{"store":"name","total":25.50,"items":[{"description":"Item","amount":5.00,"category":"Groceries"}]}`;
  const reply = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: 'Scan this receipt.' }
    ]
  }], system, 1200);
  return JSON.parse(reply.replace(/```json|```/g, '').trim());
}

async function generateAIInsights(data) {
  const system = `You are a personal finance advisor. Be concise, friendly, and practical.
Respond in the same language as the data context (Indonesian/English mix is fine).
Keep response under 200 words. Use emoji sparingly.`;
  try {
    return await callClaude([{ role: 'user', content: JSON.stringify(data) }], system, 400);
  } catch (e) {
    return null;
  }
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
  const dD = now.getDate();
  const dM = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const proj = totalExp > 0 ? (totalExp / dD) * dM : 0;

  const lines = curr.rows.map(r => {
    const amt = +r.total;
    const p   = prevMap[r.category] || 0;
    const pct = p ? ((amt - p) / p * 100) : null;
    const arr = pct === null ? '•' : pct > 5 ? '↑' : pct < -5 ? '↓' : '→';
    const ps  = pct !== null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : '';
    return `${arr} ${r.category}: *${fmtE(amt)}*${ps}`;
  }).join('\n') || '_No expenses yet_';

  return `📊 *Report — ${now.toLocaleString('default',{month:'long',year:'numeric'})}*\n\n${lines}\n\n──────────────\n💸 Total: *${fmtE(totalExp)}*\n💰 Income: ${income > 0 ? fmtE(income) : '_not set_'}\n${income > 0 ? `${totalExp <= income ? '✅' : '❌'} Net: *${fmtE(Math.abs(income - totalExp))}* ${income >= totalExp ? 'surplus' : 'deficit'}\n` : ''}📈 Projected end-of-month: *${fmtE(proj)}*`;
}

async function buildWeeklySummary() {
  const now = new Date();
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  const { from: cf, to: ct } = getMonthBounds(0);
  const { from: pf, to: pt } = getMonthBounds(-1);
  const dD = now.getDate();
  const dM = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const [weekExp, weekInc, monthExp, monthInc, prevMonthExp, top5] = await Promise.all([
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date >= $1`, [weekAgo]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Income' AND date >= $1`, [weekAgo]),
    dbQuery(`SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [cf, ct]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cf, ct]),
    dbQuery(`SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category`, [pf, pt]),
    dbQuery(`SELECT notes, category, amount FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 ORDER BY amount DESC LIMIT 5`, [cf, ct]),
  ]);

  const totalMonthExp = monthExp.rows.reduce((s,r) => s + +r.total, 0);
  const totalMonthInc = +monthInc.rows[0].t;
  const proj = totalMonthExp > 0 ? (totalMonthExp / dD) * dM : 0;
  const balance = totalMonthInc - totalMonthExp;
  const projBalance = totalMonthInc - proj;

  const prevMap = Object.fromEntries(prevMonthExp.rows.map(r => [r.category, +r.total]));
  const overCategories = monthExp.rows
    .filter(r => prevMap[r.category] && +r.total > prevMap[r.category] * 1.1)
    .map(r => `${r.category} (+${(((+r.total - prevMap[r.category]) / prevMap[r.category]) * 100).toFixed(0)}%)`);

  const top5Lines = top5.rows.map((r,i) => `${i+1}. ${r.category} — *${fmtE(r.amount)}* (${r.notes})`).join('\n');

  let msg = `📆 *Weekly Summary*\n_${weekAgo.toLocaleDateString('en-GB')} – ${now.toLocaleDateString('en-GB')}_\n\n`;
  msg += `*This week:*\n💸 Expense: *${fmtE(+weekExp.rows[0].t)}*\n💰 Income: *${fmtE(+weekInc.rows[0].t)}*\n\n`;
  msg += `*This month so far:*\n💸 Expense: *${fmtE(totalMonthExp)}*\n💰 Income: *${fmtE(totalMonthInc)}*\n${balance >= 0 ? '✅' : '❌'} Balance: *${fmtE(balance)}*\n\n`;
  msg += `*Projections (end of month):*\n📈 Expense: *${fmtE(proj)}*\n${projBalance >= 0 ? '✅' : '⚠️'} Balance: *${fmtE(projBalance)}*\n\n`;
  if (top5Lines) msg += `*Top 5 expenses:*\n${top5Lines}\n\n`;

  // AI insights for over-budget categories
  if (overCategories.length > 0) {
    msg += `⚠️ *Over vs last month:* ${overCategories.join(', ')}\n\n`;
    const insights = await generateAIInsights({
      overCategories,
      monthlyData: monthExp.rows.map(r => ({ category: r.category, amount: +r.total, prevAmount: prevMap[r.category] || 0 })),
      task: 'Give 2-3 specific saving tips for the over-budget categories. Be brief and actionable.'
    });
    if (insights) msg += `💡 *Saving tips:*\n${insights}`;
  }

  return msg;
}

async function buildMonthlySummary() {
  const { from: cf, to: ct } = getMonthBounds(0);
  const { from: pf, to: pt } = getMonthBounds(-1);
  const now = new Date();

  const [curr, prevMonthExp, incRow, top5] = await Promise.all([
    dbQuery(`SELECT category, SUM(amount) total, COUNT(*) cnt FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [cf, ct]),
    dbQuery(`SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category`, [pf, pt]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cf, ct]),
    dbQuery(`SELECT notes, category, amount FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 ORDER BY amount DESC LIMIT 5`, [cf, ct]),
  ]);

  const totalExp = curr.rows.reduce((s,r) => s + +r.total, 0);
  const income   = +incRow.rows[0].total;
  const balance  = income - totalExp;
  const prevMap  = Object.fromEntries(prevMonthExp.rows.map(r => [r.category, +r.total]));

  const catLines = curr.rows.map(r => {
    const pct = prevMap[r.category] ? ((+r.total - prevMap[r.category]) / prevMap[r.category] * 100) : null;
    const trend = pct === null ? '' : pct > 5 ? ' ↑' : pct < -5 ? ' ↓' : '';
    return `• ${r.category}: *${fmtE(r.total)}*${trend}`;
  }).join('\n');

  const top5Lines = top5.rows.map((r,i) => `${i+1}. ${r.category} — *${fmtE(r.amount)}* _(${r.notes})_`).join('\n');
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  let msg = `📅 *Monthly Summary — ${monthName}*\n\n`;
  msg += `${catLines}\n\n──────────────\n`;
  msg += `💸 Total expense: *${fmtE(totalExp)}*\n`;
  msg += `💰 Total income: *${fmtE(income)}*\n`;
  msg += `${balance >= 0 ? '✅' : '❌'} Balance: *${fmtE(Math.abs(balance))}* ${balance >= 0 ? 'surplus' : 'deficit'}\n\n`;
  if (top5Lines) msg += `*Top 5 expenses:*\n${top5Lines}\n\n`;

  const overCategories = curr.rows
    .filter(r => prevMap[r.category] && +r.total > prevMap[r.category] * 1.1)
    .map(r => r.category);

  if (overCategories.length) {
    const insights = await generateAIInsights({
      overCategories,
      totalExpense: totalExp,
      income,
      monthlyBreakdown: curr.rows.map(r => ({ category: r.category, amount: +r.total })),
      task: 'Give 3 actionable saving tips based on this monthly spending. Focus on the biggest opportunities.'
    });
    if (insights) msg += `💡 *Monthly insights:*\n${insights}`;
  }

  return msg;
}

async function buildBudgetStatus() {
  const { from, to } = getMonthBounds(0);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const [spentRows, budgetRows] = await Promise.all([
    dbQuery(`SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category`, [from, to]),
    dbQuery(`SELECT category, amount FROM budgets WHERE month=$1`, [monthKey]),
  ]);

  const spent   = Object.fromEntries(spentRows.rows.map(r => [r.category, +r.total]));
  const budgets = Object.fromEntries(budgetRows.rows.map(r => [r.category, +r.amount]));

  const totalSpent = Object.values(spent).reduce((s,v) => s+v, 0);
  const disc = ALL_CATS.filter(c => !EXEMPT_CATS.includes(c)).reduce((s,c) => s + (spent[c]||0), 0);
  const discSisa = TARGET_DISCRETIONARY - disc;
  const pct = Math.min((disc / TARGET_DISCRETIONARY) * 100, 100);
  const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10-Math.round(pct/10));

  let lines = `🎯 *Budget Monitor — ${monthKey}*\n\n`;
  lines += `*Discretionary (≤€${TARGET_DISCRETIONARY}):*\n${bar} ${pct.toFixed(0)}%\nSpent: *${fmtE(disc)}* / €${TARGET_DISCRETIONARY}\n${discSisa >= 0 ? `✅ Remaining: *${fmtE(discSisa)}*` : `❌ Over by: *${fmtE(Math.abs(discSisa))}*`}\n\n`;

  if (budgetRows.rows.length > 0) {
    lines += `*Per-category budgets:*\n`;
    for (const [cat, budget] of Object.entries(budgets)) {
      const s = spent[cat] || 0;
      const p = Math.min((s/budget)*100, 100);
      const statusIcon = p >= 100 ? '🔴' : p >= 80 ? '🟡' : '🟢';
      lines += `${statusIcon} ${cat}: ${fmtE(s)} / ${fmtE(budget)} (${p.toFixed(0)}%)\n`;
    }
  } else {
    lines += `_No per-category budgets set. Use: setbudget Groceries 200_`;
  }

  return lines;
}

async function buildRunRate() {
  const { from, to } = getMonthBounds(0);
  const now = new Date();
  const dD = now.getDate();
  const dM = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const expR = await dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]);
  const total = +expR.rows[0].t;
  const proj = (total / dD) * dM;
  const sisa = TARGET_DISCRETIONARY - total;
  return `💸 Spent *${fmtE(total)}* of *€${TARGET_DISCRETIONARY}* target\n${sisa >= 0 ? `✅ *${fmtE(sisa)}* remaining` : `⚠️ *${fmtE(Math.abs(sisa))}* over target`}\n📈 Projected end-of-month: *${fmtE(proj)}*`;
}

async function buildTop() {
  const { from, to } = getMonthBounds(0);
  const rows = await dbQuery(`SELECT notes, category, amount, date, person FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 ORDER BY amount DESC LIMIT 5`, [from, to]);
  if (!rows.rows.length) return '📈 No expenses this month yet.';
  const lines = rows.rows.map((r,i) =>
    `${i+1}. ${r.category} — *${fmtE(r.amount)}*\n   _${r.notes}_ · ${new Date(r.date).toLocaleDateString('en-GB')} · ${r.person}`
  ).join('\n\n');
  return `📈 *Top 5 This Month*\n\n${lines}`;
}

async function buildStreakInfo(chatId) {
  const row = await dbQuery(`SELECT * FROM user_streaks WHERE chat_id=$1`, [String(chatId)]);
  if (!row.rows.length) return `🔥 *Streak: 0 days*\n\nStart tracking today to build your streak!`;
  const s = row.rows[0];
  const medals = s.current_streak >= 30 ? '🏆' : s.current_streak >= 14 ? '🥇' : s.current_streak >= 7 ? '🥈' : s.current_streak >= 3 ? '🥉' : '🔥';
  return `${medals} *Streak: ${s.current_streak} days*\n🏅 Longest: ${s.longest_streak} days\n📅 Last input: ${s.last_input_date || 'never'}`;
}

async function buildRecurringList() {
  const rows = await dbQuery(`SELECT * FROM recurring_expenses WHERE active=TRUE ORDER BY name`);
  if (!rows.rows.length) return `🔄 *No recurring expenses configured.*\n\nAsk me to add one:\n_"recurring add Bus 1.50 Transportation weekdays"_`;
  const dayMap = { '1,2,3,4,5': 'weekdays', '1,2,3,4,5,6,7': 'daily', '6,7': 'weekends' };
  const lines = rows.rows.map(r =>
    `• *${r.name}* — ${fmtE(r.amount)} (${r.category})\n  ${dayMap[r.days_of_week] || r.days_of_week}`
  ).join('\n\n');
  return `🔄 *Recurring Expenses*\n\n${lines}`;
}

async function exportCSV(chatId) {
  const { from, to } = getMonthBounds(0);
  const rows = await dbQuery(`SELECT date, type, category, amount, notes, person FROM transactions WHERE date BETWEEN $1 AND $2 ORDER BY date DESC`, [from, to]);
  if (!rows.rows.length) return null;
  const header = 'Date,Type,Category,Amount,Notes,Person';
  const lines = rows.rows.map(r =>
    `"${new Date(r.date).toLocaleDateString('en-GB')}","${r.type}","${r.category}","${r.amount}","${(r.notes||'').replace(/"/g,'""')}","${r.person}"`
  );
  return [header, ...lines].join('\n');
}

function buildHelp() {
  return `🤖 *SpendBot v3 Guide*

*💸 Record expense:*
• _coffee 3.50_
• _groceries 45.20 Rimi_
• _transport 2 bus_

*🧾 Receipt:* Send a photo!

*💰 Income:*
• _income 4032.40 salary_

*📊 Reports:*
• _report_ — monthly + MoM
• _weekly_ — weekly summary + AI tips
• _monthly_ — full monthly analysis
• _budget_ — vs budget targets
• _runrate_ — projected month-end
• _top_ — biggest expenses

*🔄 Recurring:*
• _recurring_ — list auto-expenses

*🎮 Gamification:*
• _streak_ — input streak

*⚙️ Settings:*
• _setbudget Groceries 200_ — set budget
• _export_ — download CSV

*↩️ Undo:* _undo_`;
}

// ==========================================================
// 💬  COMMAND HANDLERS
// ==========================================================
async function handleExpense(text, chatId, person) {
  const parsed = await parseExpenseText(text);
  if (!parsed?.amount || parsed.amount <= 0) {
    return `🤔 Could not parse expense.

Try: _coffee 3.50_ or _groceries 45 Rimi_
Type /help for all commands.`;
  }

  await dbQuery(
    `INSERT INTO transactions (date,type,category,amount,notes,person,chat_id,source) VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'telegram')`,
    [parsed.category, parsed.amount, parsed.notes, person, String(chatId)]
  );

  // Update streak
  await updateStreak(chatId);

  const { from, to } = getMonthBounds(0);
  const now = new Date();
  const dD = now.getDate();
  const dM = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const [totR, discR] = await Promise.all([
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]),
    dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 AND NOT (category = ANY($3))`, [from, to, EXEMPT_CATS]),
  ]);

  const discSpent = +discR.rows[0].t;
  const projDisc = discSpent > 0 ? (discSpent / dD) * dM : 0;
  const projPct = Math.min((projDisc / TARGET_DISCRETIONARY) * 100, 999).toFixed(0);
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  let alert = '';
  if (!EXEMPT_CATS.includes(parsed.category)) {
    const discSisa = TARGET_DISCRETIONARY - discSpent;
    if      (discSisa < 0)   alert = `\n⚠️ *Discretionary OVER by ${fmtE(Math.abs(discSisa))}!*`;
    else if (discSisa < 100) alert = `\n⚠️ Only *${fmtE(discSisa)}* left of €${TARGET_DISCRETIONARY} discretionary`;
  }

  // Budget alert check for this category
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const budgetRow = await dbQuery(`SELECT amount FROM budgets WHERE category=$1 AND month=$2`, [parsed.category, monthKey]);
  if (budgetRow.rows.length > 0) {
    const catSpent = (await dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND category=$1 AND date BETWEEN $2 AND $3`, [parsed.category, from, to])).rows[0].t;
    const budgetAmt = +budgetRow.rows[0].amount;
    const pct = (+catSpent / budgetAmt) * 100;
    if (pct >= 100) alert += `\n🔴 *${parsed.category} budget exceeded!* (${fmtE(+catSpent)} / ${fmtE(budgetAmt)})`;
    else if (pct >= 80) alert += `\n🟡 *${parsed.category} at ${pct.toFixed(0)}% of budget* (${fmtE(+catSpent)} / ${fmtE(budgetAmt)})`;
  }

  return `✅ *Recorded!* (${person})\n\n📂 ${parsed.category}\n💸 *${fmtE(parsed.amount)}*\n📝 ${parsed.notes}\n📅 ${now.toLocaleDateString('en-GB')}\n\n📊 Total expense as of ${dateStr}: *${fmtE(discSpent)}* (${projPct}% out of €${TARGET_DISCRETIONARY} by end-of-month)${alert}`;
}

async function handleIncome(text, chatId, person) {
  const match = text.match(/[\d.,]+/);
  if (!match) return '❌ Format: _income 4032.40 salary_';
  const amount = parseFloat(match[0].replace(',', '.'));
  const notes  = text.replace(/^(income|salary|gaji|pemasukan)\s*/i, '').replace(match[0], '').trim() || 'Salary';

  await dbQuery(
    `INSERT INTO transactions (date,type,category,amount,notes,person,chat_id,source) VALUES (NOW(),'Income','Income',$1,$2,$3,$4,'telegram')`,
    [amount, notes, person, String(chatId)]
  );

  const { from, to } = getMonthBounds(0);
  const expR  = await dbQuery(`SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2`, [from, to]);
  const spent = +expR.rows[0].t;
  const sisa  = amount - spent;

  return `✅ *Income recorded!* (${person})\n\n💰 *${fmtE(amount)}* — ${notes}\n📅 ${new Date().toLocaleDateString('en-GB')}\n\n💸 Expenses this month: ${fmtE(spent)}\n${sisa >= 0 ? '✅' : '❌'} Net: *${fmtE(Math.abs(sisa))}* ${sisa >= 0 ? 'surplus' : 'deficit'}`;
}

async function handleUndo(chatId) {
  const row = await dbQuery(
    `SELECT id, category, amount, notes FROM transactions WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [String(chatId)]
  );
  if (!row.rows.length) return '❌ No recent transaction to undo.';
  const tx = row.rows[0];
  await dbQuery(`DELETE FROM transactions WHERE id=$1`, [tx.id]);
  return `🗑️ *Undone!*\n\n${tx.category}: ${fmtE(tx.amount)}\n_${tx.notes}_`;
}

async function handleSetBudget(text, chatId) {
  // Format: setbudget Category Amount
  const match = text.match(/^setbudget\s+(\w[\w\s]*?)\s+([\d.,]+)$/i);
  if (!match) return '❌ Format: _setbudget Groceries 200_';
  const category = match[1].trim();
  const amount   = parseFloat(match[2].replace(',', '.'));
  if (!ALL_CATS.some(c => c.toLowerCase() === category.toLowerCase())) {
    return `❌ Unknown category. Valid: ${ALL_CATS.join(', ')}`;
  }
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  await dbQuery(
    `INSERT INTO budgets (category, amount, month) VALUES ($1,$2,$3) ON CONFLICT (category,month) DO UPDATE SET amount=$2`,
    [category, amount, monthKey]
  );
  return `✅ Budget set: *${category}* = *${fmtE(amount)}* for ${monthKey}`;
}

async function handleRecurringAdd(text) {
  // Format: recurring add Name Amount Category [weekdays|daily|weekends]
  const match = text.match(/recurring add\s+(.+?)\s+([\d.,]+)\s+(\w[\w\s]*?)(?:\s+(weekdays|daily|weekends))?$/i);
  if (!match) return '❌ Format: _recurring add Bus 1.50 Transportation weekdays_';
  const name     = match[1].trim();
  const amount   = parseFloat(match[2].replace(',', '.'));
  const category = match[3].trim();
  const schedule = (match[4] || 'weekdays').toLowerCase();
  const daysMap  = { weekdays: '1,2,3,4,5', daily: '1,2,3,4,5,6,7', weekends: '6,7' };
  const days     = daysMap[schedule] || '1,2,3,4,5';

  await dbQuery(
    `INSERT INTO recurring_expenses (name, category, amount, notes, days_of_week) VALUES ($1,$2,$3,$4,$5)`,
    [name, category, amount, name, days]
  );
  return `✅ *Recurring added!*\n\n🔄 ${name}\n💸 ${fmtE(amount)} (${category})\n📅 ${schedule}`;
}

async function handleInvestment(text, chatId, person) {
  const t = text.toLowerCase();
  if (t.match(/^(invest|investment|portfolio)\s*(list|show|status)?\s*$/)) {
    const row = await dbQuery(`SELECT data, updated_at FROM investments ORDER BY updated_at DESC LIMIT 1`);
    if (!row.rows.length) return '📊 No investment data yet.\n\nSend: _invest update_ followed by your portfolio.';
    const inv   = JSON.parse(row.rows[0].data);
    const total = inv.reduce((s,i) => s + (i.amountRp || 0), 0);
    const lines = inv.map(i => `• ${i.type}: ${i.amountRp ? 'Rp'+Math.round(i.amountRp).toLocaleString('id') : '€'+(i.amountEur||0)}`).join('\n');
    return `📊 *Portfolio as of ${new Date(row.rows[0].updated_at).toLocaleDateString('en-GB')}*\n\n${lines}\n\n*Total: Rp${Math.round(total).toLocaleString('id')}*`;
  }
  const lines = text.split('\n').slice(1).filter(l => l.trim());
  if (!lines.length) return `📊 *How to update:*\n\`\`\`\ninvest update\nStock: Rp34895000\nMutual Fund: Rp68511875\nCash Wise: EUR9338\n\`\`\``;
  const parsed = lines.map(line => {
    const m = line.match(/^(.+?):\s*(?:Rp|IDR)?\s*([\d.,]+)|^(.+?):\s*(?:EUR|€|EURO)\s*([\d.,]+)/i);
    if (!m) return null;
    if (m[1]) {
      const rp  = parseFloat(m[2].replace(/[.,]/g,'').replace(',','.'));
      const cat = m[1].toLowerCase().includes('stock') ? 'stock' : m[1].toLowerCase().includes('mutual') ? 'mutual_fund' : m[1].toLowerCase().includes('bond') ? 'bond' : 'cash';
      return { type: m[1].trim(), category: cat, amountRp: rp };
    } else {
      return { type: m[3].trim(), category: 'cash', amountEur: parseFloat(m[4].replace(',','.')) };
    }
  }).filter(Boolean);
  if (!parsed.length) return '❌ Could not parse investments. Check format.';
  await dbQuery(`INSERT INTO investments (data, person, updated_at) VALUES ($1,$2,NOW())`, [JSON.stringify(parsed), person]);
  const total = parsed.reduce((s,i) => s + (i.amountRp||0), 0);
  return `✅ *Portfolio updated!*\n\n${parsed.map(i => `✓ ${i.type}: ${i.amountRp ? 'Rp'+Math.round(i.amountRp).toLocaleString('id') : '€'+(i.amountEur||0)}`).join('\n')}\n\n*Total: Rp${Math.round(total).toLocaleString('id')}*`;
}

async function handleReceiptPhoto(fileId, chatId, person) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  try {
    // Get file path from Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error('Could not get file info');

    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
    const imgRes  = await fetch(fileUrl);
    if (!imgRes.ok) throw new Error('Could not download image');

    const buf    = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const mime   = 'image/jpeg';

    await tgSend(chatId, '⏳ Scanning receipt...');
    const scanned = await parseReceiptImage(base64, mime);

    if (!scanned?.items?.length) {
      return '❌ Could not read the receipt.\n\nTip: Take photo straight-on, good lighting.';
    }

    let saved = 0;
    for (const item of scanned.items) {
      if (!item.amount || item.amount <= 0) continue;
      await dbQuery(
        `INSERT INTO transactions (date,type,category,amount,notes,person,chat_id,source) VALUES (NOW(),'Expense',$1,$2,$3,$4,$5,'receipt')`,
        [item.category || 'Other', item.amount, item.description, person, String(chatId)]
      );
      saved++;
    }

    await updateStreak(chatId);

    const allLines = scanned.items.filter(i => i.amount > 0).map(i => `• ${i.description}: *${fmtE(i.amount)}*`).join('\n');
    return `🧾 *Receipt Scanned!* (${person})\n\n🏪 ${scanned.store || 'Store'}\n\n${allLines}\n\n💸 *Total: ${fmtE(scanned.total)}*\n✅ ${saved} item${saved>1?'s':''} saved!`;
  } catch (err) {
    console.error('Receipt error:', err.message);
    return `❌ Receipt scan failed: ${err.message}`;
  }
}

// ==========================================================
// 🎮  STREAK
// ==========================================================
async function updateStreak(chatId) {
  const today = new Date().toISOString().split('T')[0];
  const row = await dbQuery(`SELECT * FROM user_streaks WHERE chat_id=$1`, [String(chatId)]);
  if (!row.rows.length) {
    await dbQuery(`INSERT INTO user_streaks (chat_id, current_streak, longest_streak, last_input_date) VALUES ($1,1,1,$2)`, [String(chatId), today]);
    return;
  }
  const s = row.rows[0];
  if (s.last_input_date === today) return; // Already recorded today
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  const yStr = yesterday.toISOString().split('T')[0];
  const newStreak = s.last_input_date === yStr ? s.current_streak + 1 : 1;
  const longest   = Math.max(newStreak, s.longest_streak);
  await dbQuery(`UPDATE user_streaks SET current_streak=$1, longest_streak=$2, last_input_date=$3 WHERE chat_id=$4`, [newStreak, longest, today, String(chatId)]);
}

// ==========================================================
// ⏰  CRON SCHEDULER
// ==========================================================
function startCron() {
  // Simple cron using setInterval checks — no external library needed
  const MINUTE = 60 * 1000;

  setInterval(async () => {
    const now = new Date();
    const h = now.getUTCHours() + TIMEZONE_OFFSET;
    const m = now.getUTCMinutes();
    const dow = now.getUTCDay(); // 0=Sun, 1=Mon...6=Sat

    // Auto-insert recurring expenses at 00:05 local time
    if (h % 24 === 0 && m === 5) {
      await autoInsertRecurring(dow);
    }

    // Daily reminder at 20:00 local
    if (h % 24 === 20 && m === 0) {
      await sendDailyReminder();
    }

    // Daily summary at 21:00 local
    if (h % 24 === 21 && m === 0) {
      await sendDailySummary();
    }

    // Weekly summary: Sunday at 09:00 local
    if (dow === 0 && h % 24 === 9 && m === 0) {
      await sendWeeklySummary();
    }

    // Monthly summary: 1st of month at 08:00 local
    if (now.getUTCDate() === 1 && h % 24 === 8 && m === 0) {
      await sendMonthlySummary();
    }

  }, MINUTE);

  console.log('⏰ Cron scheduler started');
}

async function autoInsertRecurring(dow) {
  if (!dbReady) return;
  try {
    // dow 0=Sun, 1=Mon..6=Sat → recurring uses 1=Mon..7=Sun
    const dayNum = dow === 0 ? 7 : dow;
    const rows = await dbQuery(`SELECT * FROM recurring_expenses WHERE active=TRUE AND days_of_week LIKE $1`, [`%${dayNum}%`]);
    let count = 0;
    for (const r of rows.rows) {
      await dbQuery(
        `INSERT INTO transactions (date,type,category,amount,notes,person,source) VALUES (NOW(),'Expense',$1,$2,$3,$4,'recurring')`,
        [r.category, r.amount, r.name, r.person]
      );
      count++;
    }
    if (count > 0) {
      await tgBroadcast(`🔄 *Auto-recorded ${count} recurring expense${count>1?'s':''}* for today.\n\nType _report_ to see updated summary.`);
    }
  } catch (e) {
    console.error('autoInsertRecurring error:', e.message);
  }
}

async function sendDailyReminder() {
  if (!dbReady) return;
  try {
    const today = new Date();
    const start = new Date(today); start.setHours(0,0,0,0);
    const rows  = await dbQuery(`SELECT COUNT(*) c FROM transactions WHERE source != 'recurring' AND created_at >= $1`, [start]);
    const count = +rows.rows[0].c;

    if (count === 0) {
      await tgBroadcast(`📝 *Daily reminder*\n\nNo expenses recorded today yet (excluding recurring).\n\nDon't forget to log your expenses! 💸`);
    } else {
      await tgBroadcast(`✅ *${count} transaction${count>1?'s':''} recorded today.* Good job!\n\nType _report_ for this month's summary.`);
    }
  } catch (e) {
    console.error('sendDailyReminder error:', e.message);
  }
}

async function sendDailySummary() {
  if (!dbReady) return;
  try {
    const today = new Date();
    const start = new Date(today); start.setHours(0,0,0,0);
    const rows  = await dbQuery(
      `SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND created_at >= $1 GROUP BY category ORDER BY total DESC`,
      [start]
    );
    if (!rows.rows.length) return; // Nothing to report

    const totalToday = rows.rows.reduce((s,r) => s+r.total, 0);
    const lines = rows.rows.map(r => `• ${r.category}: *${fmtE(r.total)}*`).join('\n');
    await tgBroadcast(`📊 *Daily Summary*\n\n${lines}\n\n💸 Total today: *${fmtE(totalToday)}*`);
  } catch (e) {
    console.error('sendDailySummary error:', e.message);
  }
}

async function sendWeeklySummary() {
  if (!dbReady) return;
  try {
    const msg = await buildWeeklySummary();
    await tgBroadcast(msg);
  } catch (e) {
    console.error('sendWeeklySummary error:', e.message);
  }
}

async function sendMonthlySummary() {
  if (!dbReady) return;
  try {
    const msg = await buildMonthlySummary();
    await tgBroadcast(msg);
  } catch (e) {
    console.error('sendMonthlySummary error:', e.message);
  }
}

// ==========================================================
// 📱  TELEGRAM WEBHOOK
// ==========================================================
app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200); // Respond immediately to Telegram

  const update = req.body;
  if (!update) return;

  // Handle photo messages (receipts)
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const person = getPerson(chatId);
  const text   = (msg.text || msg.caption || '').trim();

  console.log(`[TG] chat:${chatId} person:"${person}" | "${text.substring(0,60)}"`);

  if (!dbReady) {
    await tgSend(chatId, '⚠️ Bot is starting up, please try again in 30 seconds.');
    return;
  }

  try {
    // Photo: receipt scan
    if (msg.photo && msg.photo.length > 0) {
      const fileId = msg.photo[msg.photo.length - 1].file_id; // Largest photo
      const reply  = await handleReceiptPhoto(fileId, chatId, person);
      await tgSend(chatId, reply);
      return;
    }

    if (!text) return;

    let reply = '';
    const intent = detectIntent(text);

    switch (intent) {
      case 'start':    reply = `👋 Welcome to *SpendBot v3*, ${person}!\n\n` + buildHelp(); break;
      case 'help':     reply = buildHelp(); break;
      case 'report':   reply = await buildReport(); break;
      case 'weekly':   reply = await buildWeeklySummary(); break;
      case 'monthly':  reply = await buildMonthlySummary(); break;
      case 'budget':   reply = await buildBudgetStatus(); break;
      case 'runrate':  reply = await buildRunRate(); break;
      case 'top':      reply = await buildTop(); break;
      case 'undo':     reply = await handleUndo(chatId); break;
      case 'streak':   reply = await buildStreakInfo(chatId); break;
      case 'recurring':
        if (text.toLowerCase().startsWith('recurring add')) {
          reply = await handleRecurringAdd(text);
        } else {
          reply = await buildRecurringList();
        }
        break;
      case 'setbudget': reply = await handleSetBudget(text, chatId); break;
      case 'export':
        const csv = await exportCSV(chatId);
        if (!csv) { reply = '📊 No transactions this month yet.'; break; }
        // Send as document via Telegram sendDocument
        await sendTelegramDocument(chatId, csv, `expenses_${new Date().toISOString().split('T')[0]}.csv`);
        return;
      case 'invest':   reply = await handleInvestment(text, chatId, person); break;
      case 'income':   reply = await handleIncome(text, chatId, person); break;
      case 'expense':  reply = await handleExpense(text, chatId, person); break;
      default:         reply = buildHelp();
    }

    await tgSend(chatId, reply);
  } catch (err) {
    console.error('[TG WEBHOOK ERROR]', err.message);
    await tgSend(chatId, `⚠️ Error: ${err.message}\n\nType /help for guidance.`);
  }
});

async function sendTelegramDocument(chatId, content, filename) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const { Blob } = globalThis;
  const blob = new Blob([content], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('document', blob, filename);
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: formData });
}

// ==========================================================
// 🌐  API ENDPOINTS (for web dashboard — unchanged)
// ==========================================================
app.get('/api/stats', async (req, res) => {
  if (!dbReady) return res.json({ success: false, error: 'Database not ready' });
  try {
    const now = new Date();
    const cf  = new Date(now.getFullYear(), now.getMonth(), 1);
    const ct  = now;
    const pf  = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const pt  = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [curr, prev, ci, pi, recent] = await Promise.all([
      dbQuery(`SELECT category, SUM(amount) total, COUNT(*) cnt FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [cf, ct]),
      dbQuery(`SELECT category, SUM(amount) total FROM transactions WHERE type='Expense' AND date BETWEEN $1 AND $2 GROUP BY category`, [pf, pt]),
      dbQuery(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [cf, ct]),
      dbQuery(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='Income' AND date BETWEEN $1 AND $2`, [pf, pt]),
      dbQuery(`SELECT * FROM transactions ORDER BY date DESC LIMIT 30`),
    ]);

    const currTotal = curr.rows.reduce((s,r) => s + +r.total, 0);
    const prevTotal = prev.rows.reduce((s,r) => s + +r.total, 0);
    const income    = +ci.rows[0].total;
    const prevMap   = Object.fromEntries(prev.rows.map(r => [r.category, +r.total]));
    const dD = now.getDate();
    const dM = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();

    res.json({
      success: true,
      current: {
        from: cf, to: ct,
        totalExpense: currTotal, totalIncome: income,
        balance: income - currTotal,
        transactionCount: curr.rows.reduce((s,r) => s + +r.cnt, 0),
        byCategory: curr.rows.map(r => ({
          category: r.category, total: +r.total, count: +r.cnt,
          prevTotal: prevMap[r.category] || 0,
          growth: prevMap[r.category] ? ((+r.total - prevMap[r.category]) / prevMap[r.category] * 100) : null,
        })),
        runRate: currTotal > 0 ? (currTotal / dD) * dM : 0,
        daysElapsed: dD, daysInMonth: dM,
      },
      previous: { from: pf, to: pt, totalExpense: prevTotal, totalIncome: +pi.rows[0].total },
      recent: recent.rows,
      config: { targetDiscretionary: TARGET_DISCRETIONARY, exemptCategories: EXEMPT_CATS },
    });
  } catch (err) {
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
        `INSERT INTO transactions (date,type,category,amount,notes,person,source) VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [new Date(row.date), row.type || 'Expense', row.category, amt, row.notes || '', row.person || 'You']
      );
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/investments', async (req, res) => {
  try {
    const row = await dbQuery(`SELECT data, updated_at FROM investments ORDER BY updated_at DESC LIMIT 1`);
    if (!row.rows.length) return res.json({ success: true, data: null });
    res.json({ success: true, data: JSON.parse(row.rows[0].data), updatedAt: row.rows[0].updated_at });
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

app.get('/api/recurring', async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT * FROM recurring_expenses WHERE active=TRUE ORDER BY name`);
    res.json({ success: true, data: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/budgets', async (req, res) => {
  try {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const rows = await dbQuery(`SELECT * FROM budgets WHERE month=$1`, [monthKey]);
    res.json({ success: true, data: rows.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '🤖 SpendBot v3',
    db: dbReady ? '✅ connected' : '⚠️ not ready',
    ai: process.env.ANTHROPIC_API_KEY ? '✅ configured' : '⚠️ not set',
    telegram: process.env.TELEGRAM_BOT_TOKEN ? '✅ configured' : '⚠️ not set',
    uptime: process.uptime().toFixed(0) + 's',
  });
});

// ==========================================================
// 🚀  START
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 SpendBot v3 listening on port ${PORT}`);
  initDB().then(() => {
    if (dbReady) startCron();
  }).catch(err => console.error('DB init failed:', err.message));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
