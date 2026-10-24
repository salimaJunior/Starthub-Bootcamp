# The StartHub BootCamp Academy (website + backend)

Node.js + Express + SQLite (Node's built-in `node:sqlite`, so there is nothing to compile on Windows). Serves the website from `public/` and handles enrolment and payments.

## Run locally
```
npm install
cp .env.example .env   # fill in keys
npm start              # http://localhost:3000
```

## Payment setup
| Method | What to do |
|---|---|
| M-Pesa | Create an app at developer.safaricom.co.ke, get Consumer Key/Secret, shortcode and passkey. Go live with a Paybill/Till. |
| Card | Create a Paystack account. Webhook URL: `BASE_URL/api/paystack/webhook`. If KES isn't enabled on your account, set `PAYSTACK_CURRENCY=USD`. |
| Crypto | NOWPayments account: API key + IPN secret. |
| Airtm | Manual: student sends money to your Airtm email with their reference. Confirm with `POST /api/admin/confirm/:ref`. |

## Admin
```
curl -H "Authorization: Bearer $ADMIN_TOKEN" BASE_URL/api/admin/enrollments
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" BASE_URL/api/admin/confirm/SHB-XXXXXXXX
```

## Going live checklist
- Host on a Node server with HTTPS (Render, Railway, VPS). M-Pesa and Paystack callbacks need a public HTTPS `BASE_URL`.
- Keep prices only in `CATALOG` in `server.js` and update them if you change the website.
- Back up `academy.db` regularly (it holds student data; for minors, collect only parent contacts).
- Add confirmation emails in `onPaid()` (Resend / Nodemailer).
- Never commit `.env`.

## Email notifications
Every enrolment is emailed to **starthubbootcamp@gmail.com** twice: once when the form is submitted (awaiting payment) and again when payment is confirmed (includes the M-Pesa receipt / payment ID). The student also gets a confirmation email after paying.
Set `SMTP_USER` and `SMTP_PASS` in `.env` (for Gmail, `SMTP_PASS` must be an App Password, not your normal password).

## Changing prices
Update them in BOTH places: the `H`/`C` arrays in `public/index.html` and `CATALOG` in `server.js`. If they ever differ, the server refuses the order instead of charging the wrong amount.

## Testing without payment keys
Set `TEST_MODE=true` in `.env`. Enrolling then sends both emails (new enrolment, then paid) without charging anyone. Remove it before going live.
Always open the site at http://localhost:3000 after `npm start`. Opening `public/index.html` by double-clicking will not work, because the buttons need the server.
If a payment method has no keys yet (and TEST_MODE is off), the form still saves the details, emails you, and tells the student you'll contact them.

Requires Node.js 22.13 or newer (get the LTS from nodejs.org). If an earlier `npm install` failed, delete the `node_modules` folder and run `npm install` again.
