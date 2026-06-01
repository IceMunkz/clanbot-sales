# ClanBot Sales Server

Standalone Node.js app that runs separately from the bot runtime.

## What it does

1. Customer signs in with Steam (OpenID), enters name/email, and starts Stripe Checkout (monthly subscription).
2. `checkout.session.completed` marks the order as `awaiting_approval` for managed provisioning.
3. Admin approves from `/admin`; the server reserves a port + bot token, provisions in Pelican, and sends setup email.
4. Subscription lifecycle webhooks keep bot access synced:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`
5. Customer can use `/account` (Steam-authenticated) to view status/history and open Stripe Billing Portal.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# Fill values in .env
```

Or Docker:

```bash
cp .env.example .env
docker compose up -d --build
docker compose --profile prod up -d
```

### 2. Pelican allocations

Add allocation range `3006-3050` on your Pelican node.

### 3. Stripe

- Create monthly Price and set `STRIPE_PRICE_ID`
- Create webhook endpoint at `https://yourdomain.com/webhook`
- Subscribe to the events listed above
- Set `STRIPE_WEBHOOK_SECRET`

### 4. Add bot tokens

Add Discord app credentials in `/admin` or via API:

```bash
curl -X POST https://yourdomain.com/admin/tokens \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"123456789","bot_token":"MTIz..."}'
```

### 5. Run

```bash
node server.js
npm test
```

## Admin capabilities (`/admin`)

- Login with `ADMIN_TOKEN`
- Subscription/order manager with filtering + lifecycle actions
- User manager (grouped users + per-user order history)
- Token pool management
- Test-order creation (when `ALLOW_TEST_ORDERS=true`)

## Customer capabilities (`/account`)

- Steam-linked subscription overview
- Order history
- Launch Stripe Billing Portal (`/api/portal`)
