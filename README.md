# ClanBot Sales Server

Standalone Node.js app. Runs **separately from the bot** — its own repo, its own
container. It only talks to Stripe and your Pelican panel.

## What it does

1. Customer **signs in with Steam** (OpenID), then enters name + email → Stripe Checkout (monthly subscription). The SteamID is tied to the order.
2. Stripe fires a webhook on payment → the order is marked **awaiting approval** (managed-pilot: you approve each one) and you're notified.
3. You click **Provision** in `/admin` → the server picks the next free port (3006–3050), grabs a bot token from the pool, calls the Pelican API to create the customer's bot, and emails them their setup link.
4. **On cancel / failed payment** the bot is **suspended** (reversible); re-subscribing resumes it. `/admin` also has Suspend / Resume / Restart / Delete.

> Tip: set `PELICAN_DRY_RUN=true` to exercise the whole flow (Stripe test mode) before a live Pelican panel exists — provisioning calls are logged, not made.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# Fill in all values in .env (Steam needs SALES_URL + SALES_SESSION_SECRET)
```

Or with Docker (recommended):

```bash
cp .env.example .env   # fill it in
docker compose up -d --build            # sales site on :4000
docker compose --profile prod up -d     # + auto-HTTPS Caddy (set DOMAIN)
```

### 2. Pelican — add port allocations

In your Pelican panel:  
**Nodes → your node → Allocations → Add Allocation Range: 3006 to 3050**

All 45 ports must be registered as allocations before servers can be created.

### 3. Stripe setup

- Create a **Product** in Stripe → add a monthly **Price** → copy the `price_xxx` ID → `STRIPE_PRICE_ID`
- Create a **Webhook** endpoint pointing to `https://yourdomain.com/webhook`, subscribed to `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`, and `invoice.paid` (the last three drive suspend/resume)
- Copy the webhook signing secret → `STRIPE_WEBHOOK_SECRET`

### 4. Add bot tokens (admin panel)

Create Discord applications at https://discord.com/developers/applications — one per customer slot. You have 45 ports so create 45 apps. For each:
- Copy the **Application ID** (= Client ID)
- Copy the **Bot Token**

Then add them via the admin panel at `/admin` or via curl:

```bash
curl -X POST https://yourdomain.com/admin/tokens \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"123456789","bot_token":"MTIz..."}'
```

### 5. Run

```bash
node server.js          # or: docker compose up -d --build
npm test                # idempotency + lifecycle/access suites
```

### 6. Admin panel

Visit `/admin` — enter your `ADMIN_TOKEN`. You can:
- See how many tokens are in the pool, and available ports
- View all orders with status (incl. the verified SteamID)
- **Approve & provision** paid orders (managed pilot)
- **Suspend / Resume / Restart / Delete** a customer's bot
- Re-provision failed orders
- Add bot tokens

## Token pool strategy

Discord bots must be created manually in the Developer Portal — there's no API to create them. Recommended workflow:

1. Batch-create 10–20 Discord apps at a time (10 mins work)
2. Paste them into the admin panel
3. Set a reminder to top up when pool drops below 5

The admin panel shows "Tokens Available" at all times. If it hits 0, new purchases will fail with an alert email to the customer and you can provision manually.
