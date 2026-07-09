'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.SALES_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sales.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_events (
    event_id    TEXT PRIMARY KEY,
    order_id    INTEGER NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS token_pool (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    bot_token   TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'available',  -- available | assigned | retired
    assigned_to INTEGER REFERENCES orders(id),
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS port_pool (
    port        INTEGER PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'available',  -- available | assigned
    order_id    INTEGER REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session  TEXT UNIQUE,
    stripe_payment  TEXT,
    stripe_customer TEXT,
    stripe_subscription TEXT,
    subscription_status TEXT,
    subscription_current_period_end TEXT,
    subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    subscription_canceled_at TEXT,
    customer_email  TEXT NOT NULL,
    customer_name   TEXT,
    plan            TEXT NOT NULL DEFAULT 'standard',
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | provisioning | active | failed | refunded
    pelican_server_id INTEGER,
    pelican_port    INTEGER,
    discord_token_id INTEGER REFERENCES token_pool(id),
    setup_url       TEXT,
    error_msg       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    provisioned_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* Seed port pool 3006-3050 on first run */
const portCount = db.prepare('SELECT COUNT(*) as n FROM port_pool').get().n;
if (portCount === 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO port_pool (port) VALUES (?)');
    const insertMany = db.transaction((ports) => {
        for (const p of ports) insert.run(p);
    });
    const ports = [];
    for (let p = 3006; p <= 3050; p++) ports.push(p);
    insertMany(ports);
}

/* ── Idempotent column migrations ─────────────────────────────────────────
   The orders table predates these fields, so CREATE TABLE IF NOT EXISTS will
   not add them to databases created by earlier versions. Add them in place. */
function hasColumn(table, col) {
    return db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('${table}') WHERE name = ?`).get(col).c > 0;
}
for (const [col, ddl] of [
    ['steam_id',            'ALTER TABLE orders ADD COLUMN steam_id TEXT'],
    ['stripe_subscription', 'ALTER TABLE orders ADD COLUMN stripe_subscription TEXT'],
    ['pelican_identifier',  'ALTER TABLE orders ADD COLUMN pelican_identifier TEXT'],
    ['stripe_customer',     'ALTER TABLE orders ADD COLUMN stripe_customer TEXT'],
    ['subscription_status', 'ALTER TABLE orders ADD COLUMN subscription_status TEXT'],
    ['subscription_current_period_end', 'ALTER TABLE orders ADD COLUMN subscription_current_period_end TEXT'],
    ['subscription_cancel_at_period_end', 'ALTER TABLE orders ADD COLUMN subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0'],
    ['subscription_canceled_at', 'ALTER TABLE orders ADD COLUMN subscription_canceled_at TEXT'],
]) {
    if (!hasColumn('orders', col)) db.exec(ddl);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_steam_id ON orders(steam_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_stripe_customer ON orders(stripe_customer);
  CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(stripe_subscription);
`);

/* ── Clanbot Accounts: cross-clan directory ───────────────────────────────
   Each bot deployment (one Discord guild / clan) pushes its member roster
   here so a member logging in with Steam can see every clan they belong to
   and SSO into any of them.

   deployments : one row per clan/bot deployment that has reported in.
   memberships : steam_id ↔ guild_id (+ role), replaced wholesale on each push.

   shared_secret is nullable: v1 verifies roster pushes and signs SSO tokens
   with a single global CLANBOT_ACCOUNT_SECRET; provisioning may later set a
   per-deployment secret (getSigningSecret prefers it when present). */
db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    guild_id      TEXT PRIMARY KEY,
    clan_name     TEXT,
    dashboard_url TEXT,
    shared_secret TEXT,
    last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memberships (
    steam_id   TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (steam_id, guild_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_steam ON memberships(steam_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_guild ON memberships(guild_id);
`);

module.exports = {
    /* Token pool */
    addToken(clientId, botToken) {
        return db.prepare(
            'INSERT INTO token_pool (client_id, bot_token) VALUES (?, ?)'
        ).run(clientId, botToken);
    },
    getAvailableToken() {
        return db.prepare(
            "SELECT * FROM token_pool WHERE status = 'available' ORDER BY id LIMIT 1"
        ).get();
    },
    assignToken(tokenId, orderId) {
        db.prepare(
            "UPDATE token_pool SET status = 'assigned', assigned_to = ? WHERE id = ?"
        ).run(orderId, tokenId);
    },
    tokenPoolCount() {
        return db.prepare("SELECT COUNT(*) as n FROM token_pool WHERE status = 'available'").get().n;
    },

    /* Port pool */
    getAvailablePort() {
        return db.prepare(
            "SELECT port FROM port_pool WHERE status = 'available' ORDER BY port LIMIT 1"
        ).get();
    },
    assignPort(port, orderId) {
        db.prepare(
            "UPDATE port_pool SET status = 'assigned', order_id = ? WHERE port = ?"
        ).run(orderId, port);
    },
    releasePort(port) {
        db.prepare(
            "UPDATE port_pool SET status = 'available', order_id = NULL WHERE port = ?"
        ).run(port);
    },
    portStats() {
        return db.prepare(
            "SELECT status, COUNT(*) as n FROM port_pool GROUP BY status"
        ).all();
    },

    /* Orders */
    createOrder({ stripeSession, customerEmail, customerName, plan, steamId }) {
        return db.prepare(
            `INSERT INTO orders (stripe_session, customer_email, customer_name, plan, steam_id)
             VALUES (?, ?, ?, ?, ?)`
        ).run(stripeSession, customerEmail, customerName || null, plan || 'standard', steamId || null);
    },
    getOrderBySession(stripeSession) {
        return db.prepare('SELECT * FROM orders WHERE stripe_session = ?').get(stripeSession);
    },
    /* Look up by Stripe subscription id. Older orders stored the subscription
       in stripe_payment, so match either column for backward compatibility. */
    getOrderBySubscription(subId) {
        return db.prepare(
            'SELECT * FROM orders WHERE stripe_subscription = ? OR stripe_payment = ? ORDER BY id DESC LIMIT 1'
        ).get(subId, subId);
    },
    getOrder(id) {
        return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    },
    updateOrder(id, fields) {
        const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
        const vals = [...Object.values(fields), id];
        db.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).run(...vals);
    },
    listOrders(options = {}) {
        const input = typeof options === 'number' ? { limit: options } : options;
        const limit = Number(input.limit || 100);
        const status = input.status ? String(input.status).trim() : '';
        const search = input.search ? String(input.search).trim() : '';
        const params = [];
        let where = '1=1';

        if (status) {
            where += ' AND o.status = ?';
            params.push(status);
        }
        if (search) {
            where += ` AND (
                o.customer_email LIKE ?
                OR IFNULL(o.customer_name, '') LIKE ?
                OR IFNULL(o.steam_id, '') LIKE ?
                OR CAST(o.id AS TEXT) LIKE ?
                OR IFNULL(o.stripe_subscription, '') LIKE ?
            )`;
            const q = `%${search}%`;
            params.push(q, q, q, q, q);
        }

        params.push(limit);
        return db.prepare(
            `SELECT o.*, t.client_id FROM orders o
             LEFT JOIN token_pool t ON t.id = o.discord_token_id
             WHERE ${where}
             ORDER BY o.created_at DESC, o.id DESC
             LIMIT ?`
        ).all(...params);
    },
    listUsers(options = {}) {
        const limit = Number(options.limit || 200);
        const search = options.search ? String(options.search).trim() : '';
        const params = [];
        let where = '';
        if (search) {
            where = `
              WHERE (
                IFNULL(o.customer_email, '') LIKE ?
                OR IFNULL(o.customer_name, '') LIKE ?
                OR IFNULL(o.steam_id, '') LIKE ?
              )`;
            const q = `%${search}%`;
            params.push(q, q, q);
        }
        params.push(limit);
        return db.prepare(
            `SELECT
                o.id AS latest_order_id,
                o.customer_email,
                o.customer_name,
                o.steam_id,
                o.status,
                o.stripe_subscription,
                o.subscription_status,
                o.subscription_current_period_end,
                o.subscription_cancel_at_period_end,
                o.subscription_canceled_at,
                o.setup_url,
                o.pelican_server_id,
                o.pelican_identifier,
                o.pelican_port,
                o.created_at AS last_order_at,
                grouped.order_count
             FROM orders o
             JOIN (
                SELECT
                    MAX(id) AS latest_order_id,
                    COUNT(*) AS order_count,
                    COALESCE(NULLIF(steam_id, ''), LOWER(customer_email)) AS user_key
                FROM orders
                GROUP BY COALESCE(NULLIF(steam_id, ''), LOWER(customer_email))
             ) grouped ON grouped.latest_order_id = o.id
             ${where}
             ORDER BY o.created_at DESC, o.id DESC
             LIMIT ?`
        ).all(...params);
    },
    getOrdersForUser({ steamId, email, limit = 25 }) {
        const lim = Number(limit || 25);
        if (steamId) {
            return db.prepare(
                `SELECT o.*, t.client_id
                 FROM orders o
                 LEFT JOIN token_pool t ON t.id = o.discord_token_id
                 WHERE o.steam_id = ?
                 ORDER BY o.created_at DESC, o.id DESC
                 LIMIT ?`
            ).all(String(steamId), lim);
        }
        return db.prepare(
            `SELECT o.*, t.client_id
             FROM orders o
             LEFT JOIN token_pool t ON t.id = o.discord_token_id
             WHERE LOWER(o.customer_email) = LOWER(?)
             ORDER BY o.created_at DESC, o.id DESC
             LIMIT ?`
        ).all(String(email || ''), lim);
    },
    getLatestOrderForSteam(steamId) {
        return db.prepare(
            'SELECT * FROM orders WHERE steam_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
        ).get(String(steamId));
    },
    getLatestOrderForEmail(email) {
        return db.prepare(
            'SELECT * FROM orders WHERE LOWER(customer_email) = LOWER(?) ORDER BY created_at DESC, id DESC LIMIT 1'
        ).get(String(email));
    },
    getOrderByStripeCustomer(customerId) {
        return db.prepare(
            'SELECT * FROM orders WHERE stripe_customer = ? ORDER BY created_at DESC, id DESC LIMIT 1'
        ).get(customerId);
    },
    orderCounts() {
        return db.prepare(
            'SELECT status, COUNT(*) AS n FROM orders GROUP BY status'
        ).all();
    },

    /* Config */
    getConfig(key) {
        return db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value;
    },
    setConfig(key, value) {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
    },

    /* Idempotency: fast pre-check before acquiring any lock */
    getProcessedEvent(eventId) {
        return db.prepare('SELECT * FROM processed_events WHERE event_id = ?').get(eventId);
    },

    /* Idempotency + race-safety: atomic EXCLUSIVE transaction.
       Returns { alreadyDone: true } if event/order was already processed,
       or { alreadyDone: false, port, token } on success. */
    reserveResourcesForOrder: db.transaction((orderId, eventId) => {
        /* Guard 1: idempotency — already processed this event */
        const existing = db.prepare('SELECT * FROM processed_events WHERE event_id = ?').get(eventId);
        if (existing) return { alreadyDone: true };

        /* Guard 2: order already active */
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order || order.status === 'active') return { alreadyDone: true };

        /* Guard 3: acquire resources */
        const portRow = db.prepare("SELECT port FROM port_pool WHERE status = 'available' ORDER BY port LIMIT 1").get();
        if (!portRow) throw new Error('No ports available (3006-3050 exhausted)');

        const tokenRow = db.prepare("SELECT * FROM token_pool WHERE status = 'available' ORDER BY id LIMIT 1").get();
        if (!tokenRow) throw new Error('Token pool empty — add more bot tokens in admin panel');

        /* Assign port + token atomically */
        db.prepare("UPDATE port_pool SET status = 'assigned', order_id = ? WHERE port = ?").run(orderId, portRow.port);
        db.prepare("UPDATE token_pool SET status = 'assigned', assigned_to = ? WHERE id = ?").run(orderId, tokenRow.id);
        db.prepare('UPDATE orders SET pelican_port = ?, discord_token_id = ?, status = ? WHERE id = ?')
            .run(portRow.port, tokenRow.id, 'provisioning', orderId);

        /* Mark event as processed */
        db.prepare('INSERT INTO processed_events (event_id, order_id) VALUES (?, ?)').run(eventId, orderId);

        return { alreadyDone: false, port: portRow.port, token: tokenRow };
    }),

    /* ── Clanbot Accounts: deployments + memberships directory ──────────── */

    getDeployment(guildId) {
        return db.prepare('SELECT * FROM deployments WHERE guild_id = ?').get(String(guildId));
    },
    /* Create/refresh a deployment's metadata. Never overwrites shared_secret
       (managed separately by setDeploymentSecret / provisioning). */
    upsertDeployment({ guildId, clanName, dashboardUrl }) {
        db.prepare(
            `INSERT INTO deployments (guild_id, clan_name, dashboard_url, last_seen)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(guild_id) DO UPDATE SET
                clan_name     = COALESCE(excluded.clan_name, deployments.clan_name),
                dashboard_url = COALESCE(excluded.dashboard_url, deployments.dashboard_url),
                last_seen     = datetime('now')`
        ).run(String(guildId), clanName || null, dashboardUrl || null);
    },
    setDeploymentSecret(guildId, secret) {
        db.prepare('UPDATE deployments SET shared_secret = ? WHERE guild_id = ?')
            .run(secret ? String(secret) : null, String(guildId));
    },

    /* Replace a deployment's entire roster in one transaction. members is
       [{ steamId, role }]. Anyone no longer listed is removed from this clan. */
    replaceRoster: db.transaction((guildId, members) => {
        const gid = String(guildId);
        db.prepare('DELETE FROM memberships WHERE guild_id = ?').run(gid);
        const ins = db.prepare(
            `INSERT OR REPLACE INTO memberships (steam_id, guild_id, role, updated_at)
             VALUES (?, ?, ?, datetime('now'))`
        );
        for (const m of members || []) {
            if (!m || !m.steamId) continue;
            ins.run(String(m.steamId), gid, String(m.role || 'member'));
        }
    }),

    /* All clans a steamId belongs to, joined with deployment metadata. */
    getClansForSteam(steamId) {
        return db.prepare(
            `SELECT m.guild_id, m.role, d.clan_name, d.dashboard_url, d.last_seen
             FROM memberships m
             JOIN deployments d ON d.guild_id = m.guild_id
             WHERE m.steam_id = ?
             ORDER BY d.clan_name IS NULL, d.clan_name COLLATE NOCASE, m.guild_id`
        ).all(String(steamId));
    },
    isMemberOf(steamId, guildId) {
        return !!db.prepare(
            'SELECT 1 FROM memberships WHERE steam_id = ? AND guild_id = ?'
        ).get(String(steamId), String(guildId));
    },

    /* Return an order's port + bot token to their pools (used when a customer
       is fully deleted). Bot tokens go back to 'available' for reuse. */
    releaseResourcesForOrder: db.transaction((orderId) => {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return;
        if (order.pelican_port) {
            db.prepare("UPDATE port_pool SET status = 'available', order_id = NULL WHERE port = ?").run(order.pelican_port);
        }
        if (order.discord_token_id) {
            db.prepare("UPDATE token_pool SET status = 'available', assigned_to = NULL WHERE id = ?").run(order.discord_token_id);
        }
    }),

    db,
};
