// =============================================
// SPENDBOT - WhatsApp Expense Tracker Bot
// =============================================
// Dibuat untuk pemula - tidak perlu edit banyak!
// Hanya edit bagian KONFIGURASI di bawah ini

const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// =============================================
// CORS — izinkan dashboard Netlify terhubung
// =============================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================
// DATA SEMENTARA (disimpan di memori)
// Nanti bisa diganti database sesungguhnya
// =============================================
let expenses = [];
let budgets = {
  'makanan': 1500000,
  'transport': 800000,
  'hiburan': 1000000,
  'belanja': 600000,
  'kesehatan': 500000,
  'lainnya': 600000
};

// =============================================
// FUNGSI UTAMA: PARSING PESAN WHATSAPP
// =============================================

function parseMessage(text) {
  text = text.toLowerCase().trim();

  // --- CEK PERINTAH LAPORAN ---
  if (text.includes('laporan') || text.includes('rekap') || text.includes('summary')) {
    return { action: 'laporan' };
  }

  // --- CEK PERINTAH SISA BUDGET ---
  if (text.includes('sisa') || text.includes('budget') || text.includes('limit')) {
    return { action: 'budget' };
  }

  // --- CEK PERINTAH TOP / TERBESAR ---
  if (text.includes('top') || text.includes('terbesar') || text.includes('terbanyak')) {
    return { action: 'top' };
  }

  // --- CEK PERINTAH HAPUS TERAKHIR ---
  if (text.includes('hapus') || text.includes('batal') || text.includes('undo')) {
    return { action: 'hapus' };
  }

  // --- CEK PERINTAH BANTUAN ---
  if (text.includes('help') || text.includes('bantuan') || text.includes('cara')) {
    return { action: 'help' };
  }

  // --- PARSING PENGELUARAN ---
  // Contoh: "catat 25000 kopi" atau "25rb makan siang" atau "keluar 50k bensin"
  
  // Cari angka dalam pesan
  let amount = 0;
  
  // Format: 50rb, 25rb, 100rb (ribu)
  const rbMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:rb|ribu|k)/);
  if (rbMatch) {
    amount = parseFloat(rbMatch[1].replace(',', '.')) * 1000;
  }
  
  // Format: 50jt, 1jt (juta)
  const jtMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:jt|juta|m)/);
  if (jtMatch) {
    amount = parseFloat(jtMatch[1].replace(',', '.')) * 1000000;
  }
  
  // Format: angka biasa 25000, 50000
  if (amount === 0) {
    const numMatch = text.match(/\b(\d{4,})\b/);
    if (numMatch) {
      amount = parseInt(numMatch[1]);
    }
  }

  // Format: angka kecil seperti "25" (diasumsikan ribuan)
  if (amount === 0) {
    const smallNum = text.match(/\b(\d{1,3})\b/);
    if (smallNum && !text.includes('menit') && !text.includes('jam')) {
      amount = parseInt(smallNum[1]) * 1000;
    }
  }

  if (amount === 0) {
    return { action: 'tidak_dimengerti' };
  }

  // Tentukan kategori berdasarkan kata kunci
  let kategori = 'lainnya';
  
  const kategoriMap = {
    'makanan': ['makan', 'minum', 'kopi', 'coffee', 'resto', 'restoran', 'warung', 'bakso', 'nasi', 'ayam', 'seafood', 'pizza', 'burger', 'sushi', 'lunch', 'dinner', 'breakfast', 'sarapan', 'mie', 'bakmi', 'indomie', 'snack', 'jajan', 'boba', 'bubble', 'teh', 'susu'],
    'transport': ['grab', 'gojek', 'taxi', 'taksi', 'bensin', 'bbm', 'parkir', 'tol', 'busway', 'mrt', 'lrt', 'kereta', 'ojek', 'uber', 'maxim', 'bus', 'angkot', 'tiket pesawat', 'pesawat'],
    'hiburan': ['bioskop', 'film', 'cinema', 'netflix', 'spotify', 'game', 'steam', 'konser', 'karaoke', 'bowling', 'main', 'nonton', 'youtube premium', 'disney'],
    'belanja': ['baju', 'sepatu', 'celana', 'tas', 'shopee', 'tokopedia', 'lazada', 'amazon', 'beli', 'borong', 'toko', 'supermarket', 'indomaret', 'alfamart', 'minimarket'],
    'kesehatan': ['dokter', 'obat', 'apotek', 'rs', 'rumah sakit', 'klinik', 'vitamin', 'suplemen', 'laboratorium', 'periksa', 'check up'],
  };

  for (const [kat, keywords] of Object.entries(kategoriMap)) {
    if (keywords.some(kw => text.includes(kw))) {
      kategori = kat;
      break;
    }
  }

  // Ambil keterangan (hapus angka dan kata perintah)
  let keterangan = text
    .replace(/\b(catat|keluar|bayar|beli|tambah|input)\b/g, '')
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:rb|ribu|k|jt|juta|m)/g, '')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!keterangan) keterangan = kategori;

  return {
    action: 'catat',
    amount: amount,
    kategori: kategori,
    keterangan: keterangan
  };
}

// =============================================
// FUNGSI GENERATE BALASAN BOT
// =============================================

function formatRupiah(amount) {
  if (amount >= 1000000) {
    return `Rp ${(amount/1000000).toFixed(1).replace('.0','')}jt`;
  }
  if (amount >= 1000) {
    return `Rp ${(amount/1000).toFixed(0)}rb`;
  }
  return `Rp ${amount.toLocaleString('id')}`;
}

function getEmojiKategori(kat) {
  const emojis = {
    makanan: '🍜', transport: '🚗', hiburan: '🎬',
    belanja: '🛍️', kesehatan: '💊', lainnya: '📦'
  };
  return emojis[kat] || '📦';
}

function generateReply(parsed, fromNumber) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('id', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('id', { day: 'numeric', month: 'short', year: 'numeric' });

  // Filter expenses milik user ini
  const userExpenses = expenses.filter(e => e.from === fromNumber);
  const today = new Date().toDateString();
  const todayExpenses = userExpenses.filter(e => new Date(e.date).toDateString() === today);

  if (parsed.action === 'catat') {
    // Simpan ke data
    const newExpense = {
      id: Date.now(),
      from: fromNumber,
      amount: parsed.amount,
      kategori: parsed.kategori,
      keterangan: parsed.keterangan,
      date: now
    };
    expenses.push(newExpense);

    // Hitung total kategori hari ini
    const totalKat = userExpenses
      .filter(e => e.kategori === parsed.kategori)
      .reduce((sum, e) => sum + e.amount, 0) + parsed.amount;
    
    const budgetKat = budgets[parsed.kategori] || 600000;
    const sisaKat = budgetKat - totalKat;
    const emoji = getEmojiKategori(parsed.kategori);

    let budgetInfo = '';
    if (sisaKat < 0) {
      budgetInfo = `\n⚠️ *Budget ${parsed.kategori} MELEBIHI batas!*\nLebih ${formatRupiah(Math.abs(sisaKat))}`;
    } else if (sisaKat < budgetKat * 0.2) {
      budgetInfo = `\n⚠️ Sisa budget ${parsed.kategori}: *${formatRupiah(sisaKat)}* (hampir habis!)`;
    } else {
      budgetInfo = `\nSisa budget ${parsed.kategori}: *${formatRupiah(sisaKat)}*`;
    }

    return `✅ *Berhasil dicatat!*

${emoji} *${parsed.keterangan}*
💸 ${formatRupiah(parsed.amount)}
📂 Kategori: ${parsed.kategori}
📅 ${dateStr}, ${timeStr}
${budgetInfo}

_Ketik "laporan" untuk rekap hari ini_`;
  }

  if (parsed.action === 'laporan') {
    if (todayExpenses.length === 0) {
      return `📊 *Laporan Hari Ini*\n\nBelum ada pengeluaran hari ini! 🎉\n\n_Catat pengeluaran dengan mengirim pesan seperti:_\n_"kopi 25rb" atau "makan siang 50000"_`;
    }

    const total = todayExpenses.reduce((sum, e) => sum + e.amount, 0);
    let detail = todayExpenses
      .slice(-5) // tampilkan 5 terakhir
      .map(e => `${getEmojiKategori(e.kategori)} ${e.keterangan}: ${formatRupiah(e.amount)}`)
      .join('\n');

    // Per kategori
    const perKat = {};
    todayExpenses.forEach(e => {
      perKat[e.kategori] = (perKat[e.kategori] || 0) + e.amount;
    });
    const katSummary = Object.entries(perKat)
      .sort((a,b) => b[1]-a[1])
      .map(([k,v]) => `${getEmojiKategori(k)} ${k}: ${formatRupiah(v)}`)
      .join('\n');

    return `📊 *Laporan ${dateStr}*

💸 *Total: ${formatRupiah(total)}*
🧾 Transaksi: ${todayExpenses.length}x

*Per Kategori:*
${katSummary}

*5 Terakhir:*
${detail}`;
  }

  if (parsed.action === 'budget') {
    let budgetLines = Object.entries(budgets).map(([kat, limit]) => {
      const used = userExpenses
        .filter(e => e.kategori === kat)
        .reduce((sum, e) => sum + e.amount, 0);
      const sisa = limit - used;
      const pct = Math.round((used / limit) * 100);
      const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10));
      const emoji = getEmojiKategori(kat);
      const status = sisa < 0 ? '❌' : sisa < limit*0.2 ? '⚠️' : '✅';
      return `${status} ${emoji} ${kat}\n   ${bar} ${pct}%\n   Sisa: ${formatRupiah(Math.max(sisa,0))} dari ${formatRupiah(limit)}`;
    });

    const totalBudget = Object.values(budgets).reduce((s,v)=>s+v,0);
    const totalUsed = userExpenses.reduce((s,e)=>s+e.amount,0);
    
    return `🎯 *Status Budget Bulan Ini*

${budgetLines.join('\n\n')}

─────────────────
💼 Total: ${formatRupiah(totalUsed)} / ${formatRupiah(totalBudget)}
💰 Sisa Total: *${formatRupiah(totalBudget - totalUsed)}*`;
  }

  if (parsed.action === 'top') {
    if (userExpenses.length === 0) {
      return '📈 Belum ada data pengeluaran!\n\nMulai catat dengan mengirim: _"makan 35000"_';
    }
    
    const sorted = [...userExpenses].sort((a,b) => b.amount - a.amount).slice(0,5);
    const lines = sorted.map((e,i) => 
      `${i+1}. ${getEmojiKategori(e.kategori)} ${e.keterangan}: *${formatRupiah(e.amount)}*`
    ).join('\n');
    
    return `📈 *Top 5 Pengeluaran Terbesar*

${lines}

_Total semua: ${formatRupiah(userExpenses.reduce((s,e)=>s+e.amount,0))}_`;
  }

  if (parsed.action === 'hapus') {
    const userExp = expenses.filter(e => e.from === fromNumber);
    if (userExp.length === 0) {
      return '❌ Tidak ada pengeluaran yang bisa dihapus.';
    }
    const last = userExp[userExp.length - 1];
    expenses = expenses.filter(e => e.id !== last.id);
    return `🗑️ *Berhasil dihapus!*\n\n${getEmojiKategori(last.kategori)} ${last.keterangan}: ${formatRupiah(last.amount)}\n\n_Pengeluaran terakhir sudah dihapus._`;
  }

  if (parsed.action === 'help') {
    return `🤖 *SpendBot - Panduan Penggunaan*

*📝 Catat Pengeluaran:*
Cukup ketik nominal + keterangan:
• _"kopi 25rb"_
• _"makan siang 50000"_
• _"grab 28000"_
• _"catat 75000 nonton bioskop"_

*📊 Lihat Laporan:*
• _"laporan"_ — rekap hari ini
• _"sisa budget"_ — cek limit budget
• _"top pengeluaran"_ — terbesar

*🗑️ Koreksi:*
• _"hapus"_ atau _"undo"_ — hapus terakhir

*📂 Kategori Otomatis:*
🍜 Makanan 🚗 Transport 🎬 Hiburan
🛍️ Belanja 💊 Kesehatan 📦 Lainnya`;
  }

  // Tidak dimengerti
  return `🤔 Maaf, saya tidak mengerti.

Coba format ini:
• *"kopi 25rb"* — catat pengeluaran
• *"laporan"* — lihat rekap hari ini
• *"sisa budget"* — cek budget
• *"help"* — panduan lengkap`;
}

// =============================================
// ENDPOINT WEBHOOK (menerima pesan dari Twilio)
// =============================================

app.post('/webhook', (req, res) => {
  const messageBody = req.body.Body || '';
  const fromNumber = req.body.From || 'unknown';
  
  console.log(`[${new Date().toLocaleTimeString()}] Pesan dari ${fromNumber}: ${messageBody}`);

  const parsed = parseMessage(messageBody);
  const reply = generateReply(parsed, fromNumber);

  console.log(`[BOT] Membalas: ${reply.substring(0, 50)}...`);

  // Format respons Twilio (TwiML)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${reply}</Message>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// =============================================
// ENDPOINT API UNTUK DASHBOARD
// =============================================

// Ambil semua data (untuk dashboard)
app.get('/api/expenses', (req, res) => {
  res.json({
    success: true,
    total: expenses.length,
    data: expenses.slice(-50) // 50 terbaru
  });
});

// Statistik untuk dashboard
app.get('/api/stats', (req, res) => {
  const total = expenses.reduce((s,e) => s+e.amount, 0);
  const today = new Date().toDateString();
  const todayExp = expenses.filter(e => new Date(e.date).toDateString() === today);
  
  // Per kategori
  const perKat = {};
  expenses.forEach(e => {
    perKat[e.kategori] = (perKat[e.kategori] || 0) + e.amount;
  });

  res.json({
    success: true,
    totalAmount: total,
    totalTransaksi: expenses.length,
    todayAmount: todayExp.reduce((s,e)=>s+e.amount,0),
    todayTransaksi: todayExp.length,
    perKategori: perKat,
    budgets: budgets
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SpendBot berjalan! 🤖', 
    endpoints: ['/webhook', '/api/expenses', '/api/stats'],
    totalExpenses: expenses.length
  });
});

// =============================================
// JALANKAN SERVER
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════╗
║   🤖 SpendBot Server Aktif!        ║
║   Port: ${PORT}                       ║
║   Webhook: /webhook                ║
║   API: /api/expenses & /api/stats  ║
╚════════════════════════════════════╝
  `);
});
