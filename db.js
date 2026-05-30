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
]) {
    if (!hasColumn('orders', col)) db.exec(ddl);
}

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
    listOrders(limit = 100) {
        return db.prepare(
            `SELECT o.*, t.client_id FROM orders o
             LEFT JOIN token_pool t ON t.id = o.discord_token_id
             ORDER BY o.created_at DESC LIMIT ?`
        ).all(limit);
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
