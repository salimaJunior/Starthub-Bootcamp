require('dotenv').config();
const express = require('express'), crypto = require('crypto'), path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22+, nothing to compile (used for the local-file database)
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const E = process.env, PORT = E.PORT || 3000, BASE = E.BASE_URL || E.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; // Render fills RENDER_EXTERNAL_URL in automatically
const RATE = +E.KES_PER_USD || 130;


// ---------- Database: a local file (default) or a free hosted Turso database ----------
// Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN to use Turso (needed on hosts with no persistent disk, e.g. Render free).
const dbFile = E.DB_FILE || 'academy.db';
let lite = null, turso = null;
if (E.TURSO_DATABASE_URL) {
  const { createClient } = require('@libsql/client/web');
  turso = createClient({ url: E.TURSO_DATABASE_URL, authToken: E.TURSO_AUTH_TOKEN });
} else {
  try { fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true }); } catch (e) { /* reported below if it matters */ }
  try { lite = new DatabaseSync(dbFile); } catch (e) {
    console.error(`\n❌ Cannot open the database at "${dbFile}": ${e.message}\n   On Render with a paid plan: add a Disk mounted at /data and set DB_FILE=/data/academy.db.\n   On a free plan: use a free Turso database instead (set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN).\n`);
    process.exit(1);
  }
}
async function dbRun(kind, sql, args) {
  args = args.map((v) => (v === undefined ? null : v));
  if (lite) return lite.prepare(sql)[kind](...args);
  const r = await turso.execute({ sql, args });
  const rows = () => r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])));
  if (kind === 'get') return rows()[0];
  if (kind === 'all') return rows();
  return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
}
const db = {
  exec: async (sql) => { if (lite) lite.exec(sql); else await turso.execute(sql); },
  prepare: (sql) => ({ get: (...a) => dbRun('get', sql, a), all: (...a) => dbRun('all', sql, a), run: (...a) => dbRun('run', sql, a) }),
};

async function init() {
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY, name TEXT, email TEXT, location TEXT, phone TEXT, learner_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS enrollments(ref TEXT PRIMARY KEY, student_id INTEGER, course TEXT, day TEXT, time TEXT, amount_kes INTEGER, method TEXT, status TEXT DEFAULT 'pending', provider_ref TEXT, receipt TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, kind TEXT DEFAULT 'enrollment', note TEXT, plan_ref TEXT, inst_no INTEGER DEFAULT 1, inst_total INTEGER DEFAULT 1, due_at TEXT, token TEXT)`,
    `CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, section TEXT, name TEXT UNIQUE, icon TEXT, description TEXT, audience TEXT DEFAULT 'Adults', price INTEGER, old_price INTEGER, duration TEXT, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, class_link TEXT)`,
    `CREATE TABLE IF NOT EXISTS reminders(k TEXT PRIMARY KEY, sent_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  ]) await db.exec(stmt);
  for (const col of ["kind TEXT DEFAULT 'enrollment'", 'note TEXT', 'plan_ref TEXT', 'inst_no INTEGER DEFAULT 1', 'inst_total INTEGER DEFAULT 1', 'due_at TEXT', 'token TEXT']) { // upgrade older databases
    try { await db.exec('ALTER TABLE enrollments ADD COLUMN ' + col); } catch (e) { /* column already exists */ }
  }
  try { await db.exec('ALTER TABLE courses ADD COLUMN class_link TEXT'); } catch (e) { /* already there */ }
  if (!(await db.prepare('SELECT COUNT(*) AS c FROM courses').get()).c) { // first run: load the starting course list (prices are then edited from /admin)
    const ins = db.prepare('INSERT INTO courses(section,name,icon,description,audience,price,old_price,duration,sort) VALUES(?,?,?,?,?,?,?,?,?)');
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'courses.seed.json'), 'utf8'));
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; await ins.run(r.section, r.name, r.icon, r.description, r.audience, r.price, r.old_price ?? null, r.duration, i); }
  }
}

const app = express();
for (const m of ['get', 'post', 'put', 'delete']) { // wrap async handlers so a failure returns an error instead of hanging
  const orig = app[m].bind(app);
  app[m] = (p, ...fns) => fns.length === 0 ? orig(p) : orig(p, ...fns.map((f) => f && f.constructor && f.constructor.name === 'AsyncFunction'
    ? (req, res, next) => f(req, res, next).catch((err) => { console.error(`${m.toUpperCase()} ${req.path} failed:`, err.message); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' }); }) : f));
}
app.set('trust proxy', 1); // behind Render's load balancer: use the visitor's real IP for the rate limits
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const bearer = (req) => (req.headers.authorization || '').replace('Bearer ', '');

const BRAND = 'The StartHub BootCamp Academy', OWNER = E.OWNER_EMAIL || 'starthubbootcamp@gmail.com';
const mailer = E.SMTP_USER && E.SMTP_PASS ? nodemailer.createTransport({
  host: E.SMTP_HOST || 'smtp.gmail.com', port: +(E.SMTP_PORT || 465), secure: +(E.SMTP_PORT || 465) === 465,
  auth: { user: E.SMTP_USER, pass: E.SMTP_PASS },
  tls: { rejectUnauthorized: E.SMTP_ALLOW_SELF_SIGNED !== 'true' } }) : null; // see .env.example
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function mail(to, subject, html, replyTo, attachments) {
  try {
    if (E.RESEND_API_KEY) { // email over HTTPS: works on hosts that block SMTP (e.g. Render free)
      if (!E.MAIL_FROM && String(to).toLowerCase() !== OWNER.toLowerCase()) return console.log('[skipped: Resend without a verified domain can only email the owner] ' + subject);
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: E.MAIL_FROM || `${BRAND} <onboarding@resend.dev>`, to: [to], subject, html, reply_to: replyTo,
          attachments: (attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) }) });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return;
    }
    if (!mailer) return console.log('[email not configured] would send: ' + subject);
    await mailer.sendMail({ from: `"${BRAND}" <${E.SMTP_USER}>`, to, subject, html, replyTo, attachments });
  } catch (err) { console.error('Email failed:', err.message); }
}
const enr = async (ref) => await db.prepare(`SELECT e.*, s.name, s.email, s.phone, s.location, s.learner_type,
    COALESCE((SELECT SUM(x.amount_kes) FROM enrollments x WHERE x.plan_ref=e.plan_ref), e.amount_kes) AS plan_total,
  COALESCE((SELECT SUM(x.amount_kes) FROM enrollments x WHERE x.plan_ref=e.plan_ref AND x.status='paid'), 0) AS plan_paid
  FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.ref=?`).get(ref);
const dashLink = (e) => e.kind === 'enrollment' && e.plan_ref && e.token ? `${BASE}/my.html?o=${e.plan_ref}&t=${e.token}` : '';
function table(e) {
  const rows = [['Reference', e.ref], ['Status', e.status], ['Course', e.course], ['Amount', 'KES ' + e.amount_kes.toLocaleString()],
    ['Installment', e.inst_total > 1 ? `${e.inst_no} of ${e.inst_total}` : ''], ['Balance after this payment', e.inst_total > 1 && e.status === 'paid' ? 'KES ' + (e.plan_total - e.plan_paid).toLocaleString() : ''],
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
      ['Installment', e.inst_total > 1 ? `${e.inst_no} of ${e.inst_total}` : ''], ['Course total', e.inst_total > 1 ? 'KES ' + e.plan_total.toLocaleString() : ''],
      ['Balance remaining', e.inst_total > 1 ? 'KES ' + (e.plan_total - e.plan_paid).toLocaleString() : ''],
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
async function notifyNew(ref) {
  const e = await enr(ref), d = e.kind === 'donation';
  mail(OWNER, d ? `New donation (awaiting payment): KES ${e.amount_kes.toLocaleString()} from ${e.name}` : `New enrolment (awaiting payment): ${e.name} – ${e.course}${e.inst_total > 1 ? ` (${e.inst_total}-installment plan)` : ''}`,
    `<h3>${d ? 'New donation' : 'New enrolment'}</h3>${table(e)}`, e.email);
}
async function onPaid(ref) {
  const e = await enr(ref), d = e.kind === 'donation', first = esc(e.name.split(' ')[0]);
  const inst = e.inst_total > 1 ? ` [installment ${e.inst_no} of ${e.inst_total}]` : '', left = e.plan_total - e.plan_paid, link = dashLink(e);
  const acc = e.inst_total > 1 && e.plan_ref ? accessOf(await planRows(e.plan_ref)) : null;
  const planNote = e.inst_total > 1
    ? `<p>${left > 0 ? `Balance remaining: <b>KES ${left.toLocaleString()}</b>. ${acc && acc.state === 'active' ? `You can keep learning until <b>${fmtDay(dbDate(acc.until))}</b>. Please pay installment ${acc.next.no} (KES ${acc.next.amount.toLocaleString()}), due ${fmtDay(dbDate(acc.next.due))}, from your dashboard to continue after that: ` : 'Pay your next installment any time from your dashboard: '}<a href="${link}">${link}</a>` : 'Your course fee is now fully paid. Thank you!'}</p>`
    : (link ? `<p>Your dashboard: <a href="${link}">${link}</a></p>` : '');
  console.log(`PAID ${ref}: ${e.name} -> ${e.course} (KES ${e.amount_kes})`);
  const att = [{ filename: `receipt-${ref}.pdf`, content: await receiptPdf(e), contentType: 'application/pdf' }];
  mail(OWNER, d ? `💛 DONATION RECEIVED: KES ${e.amount_kes.toLocaleString()} from ${e.name}` : `✅ PAID: ${e.name} – ${e.course}${inst} (KES ${e.amount_kes.toLocaleString()})`,
    `<h3>${d ? 'Donation received' : 'Payment received'}</h3>${table(e)}`, e.email, att);
  mail(e.email, d ? `Thank you for supporting ${BRAND}` : `${e.inst_total > 1 && e.inst_no > 1 ? 'Payment received' : "You're enrolled"} – ${e.course}${inst}`, d
    ? `<p>Hi ${first}, thank you so much for your support. It means a lot to us. Your receipt is attached.</p>${table(e)}<p>– ${BRAND}</p>`
    : `<p>Hi ${first}, your payment was received and your spot is confirmed. Your receipt is attached.</p>${table(e)}${planNote}
    <p>We'll send your class link before your first session. Questions? WhatsApp +254768578725 or +254780502456.</p><p>– ${BRAND}</p>`, undefined, att);
}
async function markPaid(ref, receipt = '') {
  const r = await db.prepare(`UPDATE enrollments SET status='paid', paid_at=CURRENT_TIMESTAMP, receipt=? WHERE ref=? AND status!='paid'`).run(receipt, ref);
  if (r.changes) onPaid(ref).catch((err) => console.error('onPaid failed:', err.message));
}

// ---------- Webhooks (raw body needed for signatures, so these come before express.json) ----------
app.post('/api/paystack/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = crypto.createHmac('sha512', E.PAYSTACK_SECRET || '').update(req.body).digest('hex');
  if (!safeEq(sig, req.headers['x-paystack-signature'] || '')) return res.sendStatus(401);
  const ev = JSON.parse(req.body);
  const row = ev.event === 'charge.success' && await db.prepare('SELECT amount_kes FROM enrollments WHERE ref=?').get(ev.data.reference);
  if (row && ev.data.currency === psCur() && ev.data.amount === psAmount(row.amount_kes)) await markPaid(ev.data.reference, String(ev.data.id || ''));
  else if (row) console.error('Paystack amount/currency mismatch for', ev.data.reference);
  res.sendStatus(200);
});

const sortKeys = (o) => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object'
  ? Object.keys(o).sort().reduce((a, k) => (a[k] = sortKeys(o[k]), a), {}) : o;
app.post('/api/nowpayments/ipn', express.json(), async (req, res) => {
  const sig = crypto.createHmac('sha512', E.NOWPAYMENTS_IPN_SECRET || '').update(JSON.stringify(sortKeys(req.body))).digest('hex');
  if (!safeEq(sig, req.headers['x-nowpayments-sig'] || '')) return res.sendStatus(401);
  if (req.body.payment_status === 'finished') await markPaid(req.body.order_id, String(req.body.payment_id || ''));
  res.sendStatus(200);
});

app.post('/api/mpesa/callback', express.json(), async (req, res) => {
  if (!safeEq(req.query.s || '', E.MPESA_CB_SECRET || 'x')) return res.sendStatus(401); // Daraja doesn't sign callbacks
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    const row = await db.prepare('SELECT ref FROM enrollments WHERE provider_ref=?').get(cb.CheckoutRequestID);
    if (row && cb.ResultCode === 0) await markPaid(row.ref, ((cb.CallbackMetadata?.Item || []).find((i) => i.Name === 'MpesaReceiptNumber') || {}).Value || '');
    else if (row) await db.prepare(`UPDATE enrollments SET status='failed' WHERE ref=? AND status='pending'`).run(row.ref);
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
// Instalment plans: percentages of the course price. Change with INSTALLMENT_PLANS="2:50,50;3:40,30,30" or turn off with INSTALLMENTS=off
const PLANS = (() => {
  const plans = [{ id: '1', parts: [100] }];
  if (E.INSTALLMENTS !== 'off') for (const p of (E.INSTALLMENT_PLANS || '2:50,50;3:40,30,30').split(';')) {
    const [id, pcs] = p.split(':'), parts = String(pcs || '').split(',').map(Number);
    if (id && parts.length > 1 && parts.every((x) => x > 0) && parts.reduce((a, b) => a + b, 0) === 100) plans.push({ id: id.trim(), parts });
  }
  return plans;
})();
const GAP = Math.max(1, +E.INSTALLMENT_GAP_DAYS || 14);                       // days between installments
const GRACE = E.GRACE_DAYS !== undefined && E.GRACE_DAYS !== '' ? Math.max(0, +E.GRACE_DAYS) : 3; // extra days of learning access after an installment's due date
const dbDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const toDb = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const fmtDay = (d) => d.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short' });
// Learning access: after the first installment the student may learn until the next installment's due date + GRACE days.
function accessOf(rows) {
  if (!rows.some((r) => r.status === 'paid')) return { state: 'none' };
  const next = rows.find((r) => r.status !== 'paid'); if (!next) return { state: 'full' };
  const until = new Date(dbDate(next.due_at).getTime() + GRACE * 86400000);
  return { state: Date.now() <= until.getTime() ? 'active' : 'paused', until: toDb(until), next: { no: next.inst_no, amount: next.amount_kes, due: next.due_at } };
}
const planRows = async (pr) => await db.prepare('SELECT inst_no,status,due_at,amount_kes FROM enrollments WHERE plan_ref=? ORDER BY inst_no').all(pr);
const splitAmount = (price, parts) => { const out = parts.map((p) => Math.floor(price * p / 100)); out[out.length - 1] += price - out.reduce((a, b) => a + b, 0); return out; };
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
      await db.prepare('UPDATE enrollments SET provider_ref=? WHERE ref=?').run(id, ref);
      return res.json({ ref, message: 'Check your phone and enter your M-Pesa PIN…' });
    }
    if (b.method === 'card') return res.json({ ref, redirect_url: await paystackInit(ref, email, amount) }); // no channel filter: Paystack shows whatever your account has enabled
    if (b.method === 'crypto') return res.json({ ref, redirect_url: await cryptoInvoice(ref, amount) });
    res.json({ ref, message: `Send $${(amount / RATE).toFixed(2)} via Airtm to ${E.AIRTM_PAYEE_EMAIL || "our Airtm account (see WhatsApp)"} with reference ${ref}. We'll confirm manually.` });
  } catch (err) {
    console.error(`PAYMENT START FAILED [${b.method}] ${ref}: ${err.message}`); // the real reason from Paystack/Safaricom shows here
    await db.prepare(`UPDATE enrollments SET status='failed' WHERE ref=?`).run(ref);
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
  const course = await db.prepare('SELECT price FROM courses WHERE name=? AND active=1').get(String(b.course || ''));
  const amount = course && course.price; // price always comes from the database, never from the browser
  if (!amount) return res.status(400).json({ error: 'Unknown course.' });
  if (!methodsOn().includes(b.method)) return res.status(400).json({ error: 'That payment method is not available right now.' });
  if (b.expected && +b.expected !== amount) return res.status(409).json({ error: 'Prices were updated. Please refresh the page and try again.' });
  if (!s(b.name) || !s(b.location) || !s(b.phone) || !/^\S+@\S+\.\S+$/.test(s(b.email))) return res.status(400).json({ error: 'Please fill in all details correctly.' });
  const plan = PLANS.find((p) => p.id === String(b.plan || '1'));
  if (!plan) return res.status(400).json({ error: 'That payment plan is not available.' });
  const parts = splitAmount(amount, plan.parts);
  if (parts.some((x) => x < 50)) return res.status(400).json({ error: 'That payment plan is not available for this course.' });
  let phone = '';
  if (b.method === 'mpesa' && !mpesaViaPaystack()) { phone = mpesaPhone(b); if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number.' }); }
  else if (!['mpesa', 'card', 'crypto', 'airtm'].includes(b.method)) return res.status(400).json({ error: 'Choose a payment method.' });

  const st = await db.prepare('INSERT INTO students(name,email,location,phone,learner_type) VALUES(?,?,?,?,?)')
    .run(s(b.name), s(b.email), s(b.location), s(b.phone), s(b.learner_type));
  const order = 'ORD-' + crypto.randomBytes(6).toString('hex').toUpperCase(), token = crypto.randomBytes(12).toString('hex');
  const refs = parts.map(() => 'SHB-' + crypto.randomBytes(6).toString('hex').toUpperCase());
  for (let i = 0; i < parts.length; i++) // first installment is payable now, the rest are scheduled (due every 14 days)
    await db.prepare(`INSERT INTO enrollments(ref,student_id,course,day,time,amount_kes,method,status,plan_ref,inst_no,inst_total,due_at,token) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now', ?),?)`)
      .run(refs[i], st.lastInsertRowid, b.course, s(b.day), s(b.time), parts[i], b.method, i === 0 ? 'pending' : 'scheduled', order, i + 1, parts.length, `+${i * GAP} days`, token);
  await notifyNew(refs[0]);
  const send = res.json.bind(res); res.json = (o) => send(o && o.ref ? { ...o, order, token } : o); // the browser keeps the dashboard link
  return pay(res, refs[0], b, parts[0], s(b.email), phone);
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
  const st = await db.prepare('INSERT INTO students(name,email,location,phone,learner_type) VALUES(?,?,?,?,?)').run(s(b.name) || 'Anonymous friend', s(b.email), '', s(b.phone), 'Donor');
  await db.prepare("INSERT INTO enrollments(ref,student_id,course,day,time,amount_kes,method,kind,note) VALUES(?,?,'Donation','','',?,?,'donation',?)")
    .run(ref, st.lastInsertRowid, amount, b.method, s(b.message, 200));
  await notifyNew(ref);
  return pay(res, ref, b, amount, s(b.email), phone);
});

// ---------- Receipts (PDF) ----------
const rcHits = new Map();
app.get('/api/receipt/:ref', async (req, res) => {
  const n = (rcHits.get(req.ip) || 0) + 1; rcHits.set(req.ip, n); setTimeout(() => rcHits.delete(req.ip), 60000);
  if (n > 30) return res.status(429).send('Too many requests');
  const e = await enr(String(req.params.ref).slice(0, 40));
  if (!e || e.status !== 'paid') return res.sendStatus(404);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${e.ref}.pdf"`, 'Cache-Control': 'no-store' });
  res.send(await receiptPdf(e));
});

app.get('/api/courses', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rate: RATE, gap_days: GAP, methods: methodsOn(), plans: PLANS, courses: await db.prepare('SELECT id,section,name,icon,description,audience,price,old_price,duration FROM courses WHERE active=1 ORDER BY sort,id').all() });
});

app.get('/api/status/:ref', async (req, res) => {
  const r = await db.prepare('SELECT status, course, plan_ref AS ord, token, inst_total FROM enrollments WHERE ref=?').get(req.params.ref);
  r ? res.json({ status: r.status, course: r.course, order: r.ord, token: r.token, inst_total: r.inst_total }) : res.sendStatus(404);
});


// ---------- Payment reminders ----------
// Owner gets one daily digest (after 07:00 East Africa time). Students get an email 3 days before, on the due day, and every 3 days while overdue.
const eatDay = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
async function claim(key) { return (await db.prepare('INSERT OR IGNORE INTO reminders(k) VALUES(?)').run(key)).changes > 0; }
async function runReminders(force = false) {
  const now = new Date(), today = eatDay(now);
  const rows = await db.prepare(`SELECT e.ref,e.plan_ref,e.course,e.inst_no,e.inst_total,e.amount_kes,e.due_at,e.token,s.name,s.email,s.phone
    FROM enrollments e JOIN students s ON s.id=e.student_id
    WHERE e.kind='enrollment' AND e.inst_total>1 AND e.inst_no>1 AND e.status!='paid'
      AND EXISTS (SELECT 1 FROM enrollments p WHERE p.plan_ref=e.plan_ref AND p.status='paid') ORDER BY e.due_at`).all();
  const groups = { overdue: [], today: [], soon: [] }, plans = {};
  for (const r of rows) {
    const diff = dayDiff(eatDay(dbDate(r.due_at)), today); r.diff = diff;
    const g = diff > 0 ? 'overdue' : diff === 0 ? 'today' : diff >= -3 ? 'soon' : null; if (!g) continue;
    if (!plans[r.plan_ref]) plans[r.plan_ref] = accessOf(await planRows(r.plan_ref));
    r.access = plans[r.plan_ref]; groups[g].push(r);
    if (E.STUDENT_REMINDERS === 'off' || diff > 30) continue;
    const key = `${r.plan_ref}:${r.inst_no}:` + (g === 'soon' ? 'soon' : g === 'today' ? 'today' : 'late' + Math.floor((diff - 1) / 3));
    if (!(await claim(key))) continue;
    const link = `${BASE}/my.html?o=${r.plan_ref}&t=${r.token}`, due = fmtDay(dbDate(r.due_at)), first = esc(r.name.split(' ')[0]);
    const when = g === 'overdue' ? `was due on ${due} and is now ${diff} day${diff > 1 ? 's' : ''} late` : g === 'today' ? 'is due today' : `is due on ${due}`;
    const acc = r.access.state === 'paused' ? ' Your learning access is paused until this is paid.' : r.access.state === 'active' ? ` You can keep learning until ${fmtDay(dbDate(r.access.until))}.` : '';
    mail(r.email, `Payment reminder: ${r.course} (installment ${r.inst_no} of ${r.inst_total})`,
      `<p>Hi ${first}, your installment ${r.inst_no} of ${r.inst_total} for <b>${esc(r.course)}</b> (KES ${r.amount_kes.toLocaleString()}) ${when}.${acc}</p><p>Pay it in a minute from your dashboard: <a href="${link}">${link}</a></p><p>Questions? WhatsApp +254768578725.</p><p>– ${BRAND}</p>`);
  }
  const n = groups.overdue.length + groups.today.length + groups.soon.length;
  let sent = false;
  if (n && (force || (new Date(now.getTime() + 3 * 3600e3).getUTCHours() >= 7 && await claim('digest:' + today)))) {
    const line = (r) => { const a = r.access, st = a.state === 'paused' ? '<b style="color:#c0392b">ACCESS PAUSED</b>' : a.state === 'active' ? `access until ${fmtDay(dbDate(a.until))}` : '';
      const wa = 'https://wa.me/' + String(r.phone).replace(/\D/g, '').replace(/^0/, '254');
      return `<tr><td>${esc(r.name)}<br><a href="${wa}">${esc(r.phone)}</a></td><td>${esc(r.course)}<br>installment ${r.inst_no}/${r.inst_total}</td><td>KES ${r.amount_kes.toLocaleString()}</td><td>${fmtDay(dbDate(r.due_at))}${r.diff > 0 ? ` (${r.diff} day${r.diff > 1 ? 's' : ''} late)` : ''}<br>${st}</td></tr>`; };
    const sec = (title, list) => list.length ? `<h3>${title} (${list.length})</h3><table cellpadding="8" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px" border="1" bordercolor="#ddd">${list.map(line).join('')}</table>` : '';
    const total = [...groups.overdue, ...groups.today, ...groups.soon].reduce((a, r) => a + r.amount_kes, 0);
    await mail(OWNER, `Payment reminders: ${groups.overdue.length} overdue, ${groups.today.length} due today, ${groups.soon.length} due soon`,
      `<p>Outstanding installments needing attention: <b>KES ${total.toLocaleString()}</b>. Open ${BASE}/admin to follow up or mark manual payments as paid.</p>${sec('Overdue', groups.overdue)}${sec('Due today', groups.today)}${sec('Due in the next 3 days', groups.soon)}`);
    sent = true;
  }
  return { overdue: groups.overdue.length, today: groups.today.length, soon: groups.soon.length, digest_sent: sent };
}

// ---------- Student dashboard (opened with a private link: /my.html?o=ORDER&t=TOKEN) ----------
const myHits = new Map();
const tooMany = (req, res) => { const n = (myHits.get(req.ip) || 0) + 1; myHits.set(req.ip, n); setTimeout(() => myHits.delete(req.ip), 60000); if (n > 60) { res.status(429).json({ error: 'Too many requests, wait a minute.' }); return true; } return false; };
async function myRows(order, token) {
  const rows = await db.prepare(`SELECT e.ref,e.course,e.inst_no,e.inst_total,e.amount_kes,e.status,e.due_at,e.paid_at,e.method,e.token,e.student_id,s.name
    FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.plan_ref=? AND e.kind='enrollment' ORDER BY e.inst_no`).all(String(order).slice(0, 40));
  return rows.length && safeEq(rows[0].token || '', String(token || '')) ? rows : null;
}
app.get('/api/my/:order', async (req, res) => {
  if (tooMany(req, res)) return;
  const rows = await myRows(req.params.order, req.query.t); if (!rows) return res.sendStatus(404);
  const total = rows.reduce((a, r) => a + r.amount_kes, 0), paid = rows.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount_kes, 0);
  res.set('Cache-Control', 'no-store');
  const access = accessOf(rows), cl = await db.prepare('SELECT class_link FROM courses WHERE name=?').get(rows[0].course);
  res.json({ access, grace_days: GRACE, class_link: (access.state === 'active' || access.state === 'full') && cl && cl.class_link ? cl.class_link : '', name: rows[0].name, course: rows[0].course, total, paid, balance: total - paid, methods: methodsOn(),
    installments: rows.map((r) => ({ ref: r.ref, no: r.inst_no, of: r.inst_total, amount: r.amount_kes, status: r.status, due: r.due_at, paid_at: r.paid_at, method: r.method })) });
});
app.post('/api/my/:order/pay', async (req, res) => {
  if (tooMany(req, res)) return;
  const b = req.body || {}, rows = await myRows(req.params.order, b.t); if (!rows) return res.sendStatus(404);
  if (!methodsOn().includes(b.method)) return res.status(400).json({ error: 'That payment method is not available right now.' });
  const next = rows.find((r) => r.status !== 'paid'); if (!next) return res.status(400).json({ error: 'Everything is already paid. Thank you!' });
  const stu = await db.prepare('SELECT email, phone FROM students WHERE id=?').get(next.student_id);
  let phone = '';
  if (b.method === 'mpesa' && !mpesaViaPaystack()) { phone = mpesaPhone({ phone: stu.phone }); if (!phone) return res.status(400).json({ error: 'We need a valid M-Pesa number on your enrolment. Please contact us on WhatsApp.' }); }
  const ref = 'SHB-' + crypto.randomBytes(6).toString('hex').toUpperCase(); // fresh reference for every payment attempt
  await db.prepare(`UPDATE enrollments SET ref=?, method=?, status='pending', provider_ref=NULL WHERE ref=? AND status!='paid'`).run(ref, b.method, next.ref);
  return pay(res, ref, b, next.amount_kes, stu.email, phone);
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
app.get('/api/admin/enrollments', admin, async (req, res) => {
  const rows = await db.prepare(
  `SELECT e.ref,e.course,e.day,e.time,e.amount_kes,e.method,e.status,e.receipt,e.created_at,e.paid_at,e.plan_ref,e.inst_no,e.inst_total,e.due_at,e.token,s.name,s.email,s.phone,s.location,s.learner_type
   FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.kind='enrollment' ORDER BY e.created_at DESC`).all();
  const by = {};
  for (const r of rows) if (r.plan_ref) (by[r.plan_ref] ||= []).push(r); else { r.access = r.status === 'paid' ? 'full' : 'none'; }
  for (const g of Object.values(by)) { const a = accessOf([...g].sort((x, y) => x.inst_no - y.inst_no)); g.forEach((r) => { r.access = a.state; r.access_until = a.until || null; }); }
  res.json(rows);
});
app.post('/api/admin/reminders/run', admin, async (req, res) => res.json(await runReminders(true)));
app.get('/api/admin/donations', admin, async (req, res) => res.json(await db.prepare(
  `SELECT e.ref,e.amount_kes,e.method,e.status,e.receipt,e.note,e.created_at,e.paid_at,s.name,s.email,s.phone
   FROM enrollments e JOIN students s ON s.id=e.student_id WHERE e.kind='donation' ORDER BY e.created_at DESC`).all()));
app.post('/api/admin/confirm/:ref', admin, async (req, res) => { await markPaid(req.params.ref); res.json({ ok: true }); }); // for Airtm / manual payments

// ---------- Admin: courses & prices ----------
const cl = (v, n) => String(v ?? '').trim().slice(0, n);
function courseFields(b) {
  const f = { section: ['hacking', 'coding', 'package'].includes(b.section) ? b.section : null, name: cl(b.name, 80), icon: cl(b.icon, 8) || '📘',
    description: cl(b.description, 200), audience: b.audience === 'Kids' ? 'Kids' : 'Adults', price: Math.round(+b.price),
    old_price: +b.old_price > 0 ? Math.round(+b.old_price) : null, duration: cl(b.duration, 20), active: b.active === false || b.active === 0 ? 0 : 1,
    class_link: /^https?:\/\//i.test(String(b.class_link || '').trim()) ? cl(b.class_link, 300) : '' };
  return f.section && f.name.length >= 2 && f.price >= 50 && f.price <= 1000000 ? f : null;
}
app.get('/api/admin/courses', admin, async (req, res) => res.json(await db.prepare('SELECT * FROM courses ORDER BY sort,id').all()));
app.post('/api/admin/courses', admin, async (req, res) => {
  const f = courseFields(req.body || {}); if (!f) return res.status(400).json({ error: 'Check the course details (name, section and a price of at least 50).' });
  try {
    const r = await db.prepare('INSERT INTO courses(section,name,icon,description,audience,price,old_price,duration,active,class_link,sort) VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM courses))')
      .run(f.section, f.name, f.icon, f.description, f.audience, f.price, f.old_price, f.duration, f.active, f.class_link);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(409).json({ error: 'A course with that name already exists.' }); }
});
app.put('/api/admin/courses/:id', admin, async (req, res) => {
  const f = courseFields(req.body || {}); if (!f) return res.status(400).json({ error: 'Check the course details (name, section and a price of at least 50).' });
  try {
    await db.prepare('UPDATE courses SET section=?,name=?,icon=?,description=?,audience=?,price=?,old_price=?,duration=?,active=?,class_link=? WHERE id=?')
      .run(f.section, f.name, f.icon, f.description, f.audience, f.price, f.old_price, f.duration, f.active, f.class_link, +req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: 'A course with that name already exists.' }); }
});
app.delete('/api/admin/courses/:id', admin, async (req, res) => { await db.prepare('DELETE FROM courses WHERE id=?').run(+req.params.id); res.json({ ok: true }); });

init().then(() => app.listen(PORT, () => {
  setTimeout(() => runReminders().catch((e) => console.error('Reminders failed:', e.message)), 30000); // check shortly after start, then hourly
  setInterval(() => runReminders().catch((e) => console.error('Reminders failed:', e.message)), 3600e3);
  console.log(turso ? 'Database: Turso (hosted)' : `Database: ${dbFile}`);
  console.log(`The StartHub BootCamp Academy running on ${BASE}`);
  if (E.TEST_MODE === 'true') console.log('⚠️  TEST MODE ON: payments are simulated. Remove TEST_MODE before going live.');
  if (E.SMTP_ALLOW_SELF_SIGNED === 'true') console.log('⚠️  SMTP_ALLOW_SELF_SIGNED is on: email certificate checks are off. For local testing only.');
  if (!E.ADMIN_TOKEN || E.ADMIN_TOKEN.startsWith('change-me')) console.log('⚠️  Set a strong ADMIN_TOKEN in .env to protect /admin');
  if (BASE.includes('localhost') && E.RENDER) console.log('⚠️  BASE_URL points to localhost: set BASE_URL to your public https address');
  if (E.RENDER && !turso && !(E.DB_FILE || '').startsWith('/data')) console.log('⚠️  DB_FILE is not on a persistent disk: student data will be lost on redeploy. Set DB_FILE=/data/academy.db and add a disk at /data');
  if (!mailer && !E.RESEND_API_KEY) console.log('⚠️  Email not configured: set SMTP_USER and SMTP_PASS in .env');
})).catch((err) => { console.error('Start-up failed:', err.message); process.exit(1); });