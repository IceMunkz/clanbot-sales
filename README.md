# ClanBot Sales Server

Standalone Node.js app. Runs separately from the bot — deploy it in Plesk on any VPS.

## What it does

1. Customer fills in name + email on the sales page → Stripe Checkout
2. Stripe fires a webhook on successful payment
3. Server picks the next free port (3006–3050), grabs a bot token from the pool, calls the Pelican API to create a new server, and emails the customer their setup link

## Setup

### 1. Install

```bash
cd sales-server
npm install
cp .env.example .env
# Fill in all values in .env
```

### 2. Pelican — add port allocations

In your Pelican panel:  
**Nodes → your node → Allocations → Add Allocation Range: 3006 to 3050**

All 45 ports must be registered as allocations before servers can be created.

### 3. Stripe setup

- Create a **Product** in Stripe → add a monthly **Price** → copy the `price_xxx` ID → `STRIPE_PRICE_ID`
- Create a **Webhook** endpoint pointing to `https://yourdomain.com/webhook`, subscribe to `checkout.session.completed`
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
node server.js
```

In Plesk: create a Node.js app pointing to `sales-server/`, entry point `server.js`, set environment variables from `.env`.

### 6. Admin panel

Visit `/admin` — enter your `ADMIN_TOKEN`. You can:
- See how many tokens are in the pool
- See available ports
- View all orders with status
- Manually re-provision failed orders
- Add bot tokens

## Token pool strategy

Discord bots must be created manually in the Developer Portal — there's no API to create them. Recommended workflow:

1. Batch-create 10–20 Discord apps at a time (10 mins work)
2. Paste them into the admin panel
3. Set a reminder to top up when pool drops below 5

The admin panel shows "Tokens Available" at all times. If it hits 0, new purchases will fail with an alert email to the customer and you can provision manually.
