# Novorté API (Express + SQLite)

## What it does
- Register / login (JWT)
- Stores balances in SQLite (`novorte.db`)
- Creates NOWPayments invoices with `ipn_callback_url`
- `/api/webhook` credits balance when status is finished/confirmed/sending

## Setup
```bash
cd server
cp .env.example .env
# edit .env — set NOW_API_KEY, JWT_SECRET, PUBLIC_URL, FRONTEND_URL
npm install
npm start
```

## NOWPayments dashboard
IPN callback URL:
```
https://YOUR-API-HOST/api/webhook
```

## Frontend must call the API
- `POST /api/register` `{ email, password, first, last, address }`
- `POST /api/login` `{ email, password }` → `{ token, user }`
- `GET /api/me` header `Authorization: Bearer TOKEN`
- `POST /api/deposit/invoice` `{ amount }` → `{ invoice_url, order_id }`
- `GET /api/deposit/status?order_id=` after return from NOWPayments

Keep `Authorization: Bearer <token>` on protected routes.

## Deploy
Any Node host (Railway, Render, VPS). Set env vars. Point `PUBLIC_URL` at the public API URL.
