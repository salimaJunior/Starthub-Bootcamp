require('dotenv').config();
const express = require('express'), crypto = require('crypto'), path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22+, nothing to compile
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const E = process.env, PORT = E.PORT || 3000, BASE = E.BASE_URL || `http://localhost:${PORT}`;
const RATE = +E.KES_PER_USD || 130;


const db = new DatabaseSync(E.DB_FILE || 'academy.db');
db.exec(`
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY, name TEXT, email TEXT, location TEXT, phone TEXT,
  learner_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS enrollments(ref TEXT PRIMARY KEY, student_id INTEGER, course TEXT, day TEXT, time TEXT,
  amount_kes INTEGER, method TEXT, status TEXT DEFAULT 'pending', provider_ref TEXT, receipt TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, kind TEXT DEFAULT 'enrollment', note TEXT);`);

for (const col of ["kind TEXT DEFAULT 'enrollment'", 'note TEXT']) { // upgrade older databases
  try { db.exec('ALTER TABLE enrollments ADD COLUMN ' + col); } catch (e) { /* column already exists */ }
}

db.exec(`CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, section TEXT, name TEXT UNIQUE, icon TEXT, description TEXT,
  audience TEXT DEFAULT 'Adults', price INTEGER, old_price INTEGER, duration TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);`);
if (!db.prepare('SELECT COUNT(*) AS c FROM courses').get().c) { // first run: load the starting course list (prices are then edited from /admin)
  const ins = db.prepare('INSERT INTO courses(section,name,icon,description,audience,price,old_price,duration,sort) VALUES(?,?,?,?,?,?,?,?,?)');
  JSON.parse(fs.readFileSync(path.join(__dirname, 'courses.seed.json'), 'utf8')).forEach((r, i) =>
    ins.run(r.section, r.name, r.icon, r.description, r.audience, r.price, r.old_price ?? null, r.duration, i));
}

const app = express();
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const bearer = (req) => (req.headers.authorization || '').replace('Bearer ', '');

const BRAND = 'The StartHub BootCamp Academy', OWNER = E.OWNER_EMAIL || 'starthubbootcamp@gmail.com';
const mailer = E.SMTP_USER && E.SMTP_PASS ? nodemailer.createTransport({
  host: E.SMTP_HOST || 'smtp.gmail.com', port: +(E.SMTP_PORT || 465), secure: +(E.SMTP_PORT || 465) === 465,
  auth: { user: E.SMTP_USER, pass: E.SMTP_PASS },
  tls: { rejectUnauthorized: E.SMTP_ALLOW_SELF_SIGNED !== 'true' } }) : null; // see .env.example
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function mail(to, subject, html, replyTo, attachments) {
  if (!mailer) return console.log('[email not configured] would send: ' + subject);
  try { await mailer.sendMail({ from: `"${BRAND}" <${E.SMTP_USER}>`, to, subject, html, replyTo, attachments }); }
  catch (err) { console.error('Email failed:', err.message); }
}
const enr = (ref) => db.prepare(`SELECT e.*, s.name, s.email, s.phone, s.location, s.learner_type
  FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.ref=?`).get(ref);
function table(e) {
  const rows = [['Reference', e.ref], ['Status', e.status], ['Course', e.course], ['Amount', 'KES ' + e.amount_kes.toLocaleString()],
    ['Payment method', e.method], ['Receipt / ID', e.receipt], ['Name', e.name], ['Email', e.email], ['Phone / WhatsApp', e.phone],
    ['Location', e.location], ['Learner type', e.learner_type], ['Class day', e.day], ['Class time (EAT)', e.time], ['Message', e.note]];
  return '<table cellpadding="8" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' + rows.filter((r) => r[1]).map((r) =>
    `<tr><td style="border:1px solid #ddd;background:#f5f7fa"><b>${r[0]}</b></td><td style="border:1px solid #ddd">${esc(r[1])}</td></tr>`).join('') + '</table>';
}
const latin = (v) => String(v ?? '').replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?'); // built-in PDF fonts only draw Latin characters
const METHOD_NAME = { mpesa: 'M-Pesa', card: 'Card', crypto: 'Crypto', airtm: 'Airtm' };
function receiptPdf(e) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 }), chunks = [];
    doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    const logo = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logo)) doc.image(logo, 50, 42, { width: 72 });
    doc.fillColor('#0b1a2b').font('Helvetica-Bold').fontSize(20).text(BRAND, 138, 56);
    doc.font('Helvetica').fontSize(10).fillColor('#556').text('starthubbootcamp@gmail.com  |  +254 768 578 725  |  +254 780 502 456', 138, 84);
    doc.moveTo(50, 130).lineTo(545, 130).lineWidth(2).strokeColor('#00c8ff').stroke();
    doc.fillColor('#0b1a2b').font('Helvetica-Bold').fontSize(18).text('PAYMENT RECEIPT', 50, 148);
    doc.fillColor('#00935a').fontSize(11).text('PAID', 50, 172);
    const paid = e.paid_at ? new Date(e.paid_at.replace(' ', 'T') + 'Z').toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'long', timeStyle: 'short' }) : '';
    const donation = e.kind === 'donation';
    const rows = [['Receipt number', e.ref], ['Date paid (EAT)', paid], ['Received from', e.name], ['Email', e.email],
      ['Description', donation ? 'Donation - support for the bootcamp' : e.course], ['Class slot', !donation && e.day ? `${e.day}s at ${e.time}` : ''],
      ['Payment method', METHOD_NAME[e.method] || e.method], ['Payment ID', e.receipt]];
    let y = 215;
    for (const [k, v] of rows) {
      if (!v) continue;
      doc.font('Helvetica').fontSize(10).fillColor('#667').text(k, 50, y);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b1a2b').text(latin(v), 200, y, { width: 340 }); y += 28;
    }
    doc.roundedRect(50, y + 10, 495, 62, 8).fillAndStroke('#eefaf5', '#00935a');
    doc.fillColor('#0b1a2b').font('Helvetica').fontSize(10).text('AMOUNT PAID', 68, y + 24);
    doc.font('Helvetica-Bold').fontSize(22).text('KES ' + e.amount_kes.toLocaleString('en-US'), 68, y + 40);
    doc.font('Helvetica').fontSize(10).fillColor('#556').text(donation ? 'Thank you for supporting young people learning ethical hacking and coding.' : 'Thank you for choosing us. See you in class!', 50, y + 100);
    doc.fontSize(8).fillColor('#889').text('This receipt was generated electronically and is valid without a signature.', 50, 770);
    doc.end();
  });
}
function notifyNew(ref) {
  const e = enr(ref), d = e.kind === 'donation';
  mail(OWNER, d ? `New donation (awaiting payment): KES ${e.amount_kes.toLocaleString()} from ${e.name}` : `New enrolment (awaiting payment): ${e.name} – ${e.course}`,
    `<h3>${d ? 'New donation' : 'New enrolment'}</h3>${table(e)}`, e.email);
}
async function onPaid(ref) {
  const e = enr(ref), d = e.kind === 'donation', first = esc(e.name.split(' ')[0]);
  console.log(`PAID ${ref}: ${e.name} -> ${e.course} (KES ${e.amount_kes})`);
  const att = [{ filename: `receipt-${ref}.pdf`, content: await receiptPdf(e), contentType: 'application/pdf' }];
  mail(OWNER, d ? `💛 DONATION RECEIVED: KES ${e.amount_kes.toLocaleString()} from ${e.name}` : `✅ PAID: ${e.name} – ${e.course} (KES ${e.amount_kes.toLocaleString()})`,
    `<h3>${d ? 'Donation received' : 'Payment received'}</h3>${table(e)}`, e.email, att);
  mail(e.email, d ? `Thank you for supporting ${BRAND}` : `You're enrolled – ${e.course}`, d
    ? `<p>Hi ${first}, thank you so much for your support. It means a lot to us. Your receipt is attached.</p>${table(e)}<p>– ${BRAND}</p>`
    : `<p>Hi ${first}, your payment was received and your spot is confirmed. Your receipt is attached.</p>${table(e)}
    <p>We'll send your class link before your first session. Questions? WhatsApp +254768578725 or +254780502456.</p><p>– ${BRAND}</p>`, undefined, att);
}
function markPaid(ref, receipt = '') {
  const r = db.prepare(`UPDATE enrollments SET status='paid', paid_at=CURRENT_TIMESTAMP, receipt=? WHERE ref=? AND status!='paid'`).run(receipt, ref);
  if (r.changes) onPaid(ref).catch((err) => console.error('onPaid failed:', err.message));
}

// ---------- Webhooks (raw body needed for signatures, so these come before express.json) ----------
app.post('/api/paystack/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const sig = crypto.createHmac('sha512', E.PAYSTACK_SECRET || '').update(req.body).digest('hex');
  if (!safeEq(sig, req.headers['x-paystack-signature'] || '')) return res.sendStatus(401);
  const ev = JSON.parse(req.body);
  const row = ev.event === 'charge.success' && db.prepare('SELECT amount_kes FROM enrollments WHERE ref=?').get(ev.data.reference);
  if (row && ev.data.currency === psCur() && ev.data.amount === psAmount(row.amount_kes)) markPaid(ev.data.reference, String(ev.data.id || ''));
  else if (row) console.error('Paystack amount/currency mismatch for', ev.data.reference);
  res.sendStatus(200);
});

const sortKeys = (o) => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object'
  ? Object.keys(o).sort().reduce((a, k) => (a[k] = sortKeys(o[k]), a), {}) : o;
app.post('/api/nowpayments/ipn', express.json(), (req, res) => {
  const sig = crypto.createHmac('sha512', E.NOWPAYMENTS_IPN_SECRET || '').update(JSON.stringify(sortKeys(req.body))).digest('hex');
  if (!safeEq(sig, req.headers['x-nowpayments-sig'] || '')) return res.sendStatus(401);
  if (req.body.payment_status === 'finished') markPaid(req.body.order_id, String(req.body.payment_id || ''));
  res.sendStatus(200);
});

app.post('/api/mpesa/callback', express.json(), (req, res) => {
  if (!safeEq(req.query.s || '', E.MPESA_CB_SECRET || 'x')) return res.sendStatus(401); // Daraja doesn't sign callbacks
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    const row = db.prepare('SELECT ref FROM enrollments WHERE provider_ref=?').get(cb.CheckoutRequestID);
    if (row) cb.ResultCode === 0 ? markPaid(row.ref, ((cb.CallbackMetadata?.Item || []).find((i) => i.Name === 'MpesaReceiptNumber') || {}).Value || '') : db.prepare(`UPDATE enrollments SET status='failed' WHERE ref=? AND status='pending'`).run(row.ref);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Payment providers ----------
async function mpesaStk(ref, amount, phone) {
  const host = E.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const tk = await (await fetch(`${host}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${E.MPESA_KEY}:${E.MPESA_SECRET}`).toString('base64') } })).json();
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const r = await (await fetch(`${host}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: E.MPESA_SHORTCODE, Password: Buffer.from(E.MPESA_SHORTCODE + E.MPESA_PASSKEY + ts).toString('base64'),
      Timestamp: ts, TransactionType: E.MPESA_TXN_TYPE || 'CustomerPayBillOnline', Amount: amount, PartyA: phone, PartyB: E.MPESA_PARTYB || E.MPESA_SHORTCODE,
      PhoneNumber: phone, CallBackURL: `${BASE}/api/mpesa/callback?s=${E.MPESA_CB_SECRET}`, AccountReference: ref, TransactionDesc: 'Course fee' }) })).json();
  if (r.ResponseCode !== '0') throw new Error(r.errorMessage || r.ResponseDescription || 'M-Pesa request failed');
  return r.CheckoutRequestID;
}
const methodsOn = () => (E.PAYMENT_METHODS || 'mpesa,card,crypto,airtm').split(',').map((x) => x.trim()).filter(Boolean); // hide methods that aren't ready yet
const mpesaViaPaystack = () => E.MPESA_VIA !== 'daraja'; // default: M-Pesa STK push handled by Paystack
const psCur = () => E.PAYSTACK_CURRENCY || 'KES';
const psAmount = (kes) => Math.round((psCur() === 'KES' ? kes : kes / RATE) * 100); // Paystack counts in the smallest unit (KES 1,500 = 150000)
async function paystackInit(ref, email, kes, channels) {
  const r = await (await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST',
    headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: psAmount(kes), currency: psCur(), reference: ref, channels, callback_url: `${BASE}/?ref=${ref}` }) })).json();
  if (!r.status) throw new Error(r.message || 'Checkout failed');
  return r.data.authorization_url;
}
async function cryptoInvoice(ref, kes) {
  const r = await (await fetch('https://api.nowpayments.io/v1/invoice', { method: 'POST',
    headers: { 'x-api-key': E.NOWPAYMENTS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price_amount: +(kes / RATE).toFixed(2), price_currency: 'usd', order_id: ref,
      ipn_callback_url: `${BASE}/api/nowpayments/ipn`, success_url: `${BASE}/?ref=${ref}`, cancel_url: BASE }) })).json();
  if (!r.invoice_url) throw new Error('Crypto checkout failed');
  return r.invoice_url;
}

// Starts the payment for any order (enrolment or donation) and replies to the browser
async function pay(res, ref, b, amount, email, phone) {
  const needs = { mpesa: mpesaViaPaystack() ? ['PAYSTACK_SECRET'] : ['MPESA_KEY', 'MPESA_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'], card: ['PAYSTACK_SECRET'], crypto: ['NOWPAYMENTS_KEY'] };
  if (E.TEST_MODE === 'true') { // simulate a successful payment so you can test the emails
    setTimeout(() => markPaid(ref, 'TEST-' + ref), 4000);
    return res.json({ ref, message: 'TEST MODE: no real money taken. Simulating a payment…' });
  }
  if ((needs[b.method] || []).some((k) => !E[k]))
    return res.json({ ref, noPoll: true, message: "Thank you! We've received your details. Online payment for this method isn't switched on yet, so we'll contact you shortly to complete it." });
  try {
    if (b.method === 'mpesa' && mpesaViaPaystack()) return res.json({ ref, redirect_url: await paystackInit(ref, email, amount, ['mobile_money']) });
    if (b.method === 'mpesa') {
      const id = await mpesaStk(ref, amount, phone);
      db.prepare('UPDATE enrollments SET provider_ref=? WHERE ref=?').run(id, ref);
      return res.json({ ref, message: 'Check your phone and enter your M-Pesa PIN…' });
    }
    if (b.method === 'card') return res.json({ ref, redirect_url: await paystackInit(ref, email, amount) }); // no channel filter: Paystack shows whatever your account has enabled
    if (b.method === 'crypto') return res.json({ ref, redirect_url: await cryptoInvoice(ref, amount) });
    res.json({ ref, message: `Send $${(amount / RATE).toFixed(2)} via Airtm to ${E.AIRTM_PAYEE_EMAIL || "our Airtm account (see WhatsApp)"} with reference ${ref}. We'll confirm manually.` });
  } catch (err) {
    console.error(`PAYMENT START FAILED [${b.method}] ${ref}: ${err.message}`); // the real reason from Paystack/Safaricom shows here
    db.prepare(`UPDATE enrollments SET status='failed' WHERE ref=?`).run(ref);
    res.status(502).json({ error: 'Payment could not be started. Please try again.' });
  }
}

function mpesaPhone(b) {
  let p = String(b.mpesa_phone || b.phone || '').replace(/\D/g, '');
  if (/^0/.test(p)) p = '254' + p.slice(1); else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

// ---------- Enrol ----------
const hits = new Map();
app.post('/api/enroll', async (req, res) => {
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n); setTimeout(() => hits.delete(req.ip), 60000);
  if (n > 8) return res.status(429).json({ error: 'Too many attempts, try again in a minute.' });
  const b = req.body || {}, s = (v) => String(v || '').trim().slice(0, 120);
  const course = db.prepare('SELECT price FROM courses WHERE name=? AND active=1').get(String(b.course || ''));
  const amount = course && course.price; // price always comes from the database, never from the browser
  if (!amount) return res.status(400).json({ error: 'Unknown course.' });
  if (!methodsOn().includes(b.method)) return res.status(400).json({ error: 'That payment method is not available right now.' });
  if (b.expected && +b.expected !== amount) return res.status(409).json({ error: 'Prices were updated. Please refresh the page and try again.' });
  if (!s(b.name) || !s(b.location) || !s(b.phone) || !/^\S+@\S+\.\S+$/.test(s(b.email))) return res.status(400).json({ error: 'Please fill in all details correctly.' });
  const ref = 'SHB-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  let phone = '';
  if (b.method === 'mpesa' && !mpesaViaPaystack()) { phone = mpesaPhone(b); if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number.' }); }
  else if (!['mpesa', 'card', 'crypto', 'airtm'].includes(b.method)) return res.status(400).json({ error: 'Choose a payment method.' });

  const st = db.prepare('INSERT INTO students(name,email,location,phone,learner_type) VALUES(?,?,?,?,?)')
    .run(s(b.name), s(b.email), s(b.location), s(b.phone), s(b.learner_type));
  db.prepare('INSERT INTO enrollments(ref,student_id,course,day,time,amount_kes,method) VALUES(?,?,?,?,?,?,?)')
    .run(ref, st.lastInsertRowid, b.course, s(b.day), s(b.time), amount, b.method);
  notifyNew(ref);
  return pay(res, ref, b, amount, s(b.email), phone);
});

// ---------- Donations ----------
app.post('/api/donate', async (req, res) => {
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n); setTimeout(() => hits.delete(req.ip), 60000);
  if (n > 8) return res.status(429).json({ error: 'Too many attempts, try again in a minute.' });
  const b = req.body || {}, s = (v, l = 120) => String(v || '').trim().slice(0, l), amount = Math.round(+b.amount);
  if (!(amount >= 50 && amount <= 1000000)) return res.status(400).json({ error: 'Please enter an amount between KES 50 and KES 1,000,000.' });
  if (!/^\S+@\S+\.\S+$/.test(s(b.email))) return res.status(400).json({ error: 'Please enter a valid email so we can send your receipt.' });
  if (!methodsOn().includes(b.method)) return res.status(400).json({ error: 'That payment method is not available right now.' });
  let phone = '';
  if (b.method === 'mpesa' && !mpesaViaPaystack()) { phone = mpesaPhone(b); if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number.' }); }
  const ref = 'DON-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const st = db.prepare('INSERT INTO students(name,email,location,phone,learner_type) VALUES(?,?,?,?,?)').run(s(b.name) || 'Anonymous friend', s(b.email), '', s(b.phone), 'Donor');
  db.prepare("INSERT INTO enrollments(ref,student_id,course,day,time,amount_kes,method,kind,note) VALUES(?,?,'Donation','','',?,?,'donation',?)")
    .run(ref, st.lastInsertRowid, amount, b.method, s(b.message, 200));
  notifyNew(ref);
  return pay(res, ref, b, amount, s(b.email), phone);
});

// ---------- Receipts (PDF) ----------
const rcHits = new Map();
app.get('/api/receipt/:ref', async (req, res) => {
  const n = (rcHits.get(req.ip) || 0) + 1; rcHits.set(req.ip, n); setTimeout(() => rcHits.delete(req.ip), 60000);
  if (n > 30) return res.status(429).send('Too many requests');
  const e = enr(String(req.params.ref).slice(0, 40));
  if (!e || e.status !== 'paid') return res.sendStatus(404);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${e.ref}.pdf"`, 'Cache-Control': 'no-store' });
  res.send(await receiptPdf(e));
});

app.get('/api/courses', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rate: RATE, methods: methodsOn(), courses: db.prepare('SELECT id,section,name,icon,description,audience,price,old_price,duration FROM courses WHERE active=1 ORDER BY sort,id').all() });
});

app.get('/api/status/:ref', (req, res) => {
  const r = db.prepare('SELECT status, course FROM enrollments WHERE ref=?').get(req.params.ref);
  r ? res.json(r) : res.sendStatus(404);
});

// ---------- Admin (Authorization: Bearer ADMIN_TOKEN) ----------
const badTries = new Map();
const admin = (req, res, next) => {
  const n = badTries.get(req.ip) || 0;
  if (n >= 10) return res.status(429).json({ error: 'Too many attempts' });
  if (E.ADMIN_TOKEN && safeEq(bearer(req), E.ADMIN_TOKEN)) return next();
  badTries.set(req.ip, n + 1); setTimeout(() => badTries.delete(req.ip), 15 * 60 * 1000);
  res.sendStatus(401);
};
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/admin/enrollments', admin, (req, res) => res.json(db.prepare(
  `SELECT e.ref,e.course,e.day,e.time,e.amount_kes,e.method,e.status,e.receipt,e.created_at,e.paid_at,s.name,s.email,s.phone,s.location,s.learner_type
   FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.kind='enrollment' ORDER BY e.created_at DESC`).all()));
app.get('/api/admin/donations', admin, (req, res) => res.json(db.prepare(
  `SELECT e.ref,e.amount_kes,e.method,e.status,e.receipt,e.note,e.created_at,e.paid_at,s.name,s.email,s.phone
   FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.kind='donation' ORDER BY e.created_at DESC`).all()));
app.post('/api/admin/confirm/:ref', admin, (req, res) => { markPaid(req.params.ref); res.json({ ok: true }); }); // for Airtm / manual payments

// ---------- Admin: courses & prices ----------
const cl = (v, n) => String(v ?? '').trim().slice(0, n);
function courseFields(b) {
  const f = { section: ['hacking', 'coding', 'package'].includes(b.section) ? b.section : null, name: cl(b.name, 80), icon: cl(b.icon, 8) || '📘',
    description: cl(b.description, 200), audience: b.audience === 'Kids' ? 'Kids' : 'Adults', price: Math.round(+b.price),
    old_price: +b.old_price > 0 ? Math.round(+b.old_price) : null, duration: cl(b.duration, 20), active: b.active === false || b.active === 0 ? 0 : 1 };
  return f.section && f.name.length >= 2 && f.price >= 50 && f.price <= 1000000 ? f : null;
}
app.get('/api/admin/courses', admin, (req, res) => res.json(db.prepare('SELECT * FROM courses ORDER BY sort,id').all()));
app.post('/api/admin/courses', admin, (req, res) => {
  const f = courseFields(req.body || {}); if (!f) return res.status(400).json({ error: 'Check the course details (name, section and a price of at least 50).' });
  try {
    const r = db.prepare('INSERT INTO courses(section,name,icon,description,audience,price,old_price,duration,active,sort) VALUES(?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM courses))')
      .run(f.section, f.name, f.icon, f.description, f.audience, f.price, f.old_price, f.duration, f.active);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(409).json({ error: 'A course with that name already exists.' }); }
});
app.put('/api/admin/courses/:id', admin, (req, res) => {
  const f = courseFields(req.body || {}); if (!f) return res.status(400).json({ error: 'Check the course details (name, section and a price of at least 50).' });
  try {
    db.prepare('UPDATE courses SET section=?,name=?,icon=?,description=?,audience=?,price=?,old_price=?,duration=?,active=? WHERE id=?')
      .run(f.section, f.name, f.icon, f.description, f.audience, f.price, f.old_price, f.duration, f.active, +req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: 'A course with that name already exists.' }); }
});
app.delete('/api/admin/courses/:id', admin, (req, res) => { db.prepare('DELETE FROM courses WHERE id=?').run(+req.params.id); res.json({ ok: true }); });

app.listen(PORT, () => {
  console.log(`The StartHub BootCamp Academy running on ${BASE}`);
  if (E.TEST_MODE === 'true') console.log('⚠️  TEST MODE ON: payments are simulated. Remove TEST_MODE before going live.');
  if (E.SMTP_ALLOW_SELF_SIGNED === 'true') console.log('⚠️  SMTP_ALLOW_SELF_SIGNED is on: email certificate checks are off. For local testing only.');
  if (!E.ADMIN_TOKEN || E.ADMIN_TOKEN.startsWith('change-me')) console.log('⚠️  Set a strong ADMIN_TOKEN in .env to protect /admin');
  if (!mailer) console.log('⚠️  Email not configured: set SMTP_USER and SMTP_PASS in .env');
});
