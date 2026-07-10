'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

/* ── ClanBot Platform: first-class clans (the website-side Clan Manager) ──
   A clan can exist with NO bot deployment — the platform is the daily driver
   (roster, wipe planning, later Discord + recruitment); a deployment is the
   premium wipe-time add-on linked via deployment_guild_id. Deployment-backed
   clans are auto-materialized from roster pushes (bridgeDeploymentClan). */
db.exec(`
  CREATE TABLE IF NOT EXISTS clans (
    clan_id             TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    tag                 TEXT,
    owner_steam_id      TEXT NOT NULL,
    deployment_guild_id TEXT UNIQUE,
    discord_guild_id    TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clan_members (
    clan_id  TEXT NOT NULL,
    steam_id TEXT NOT NULL,
    name     TEXT,
    role     TEXT NOT NULL DEFAULT 'member',  -- owner | leader | member
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clan_id, steam_id)
  );
  CREATE INDEX IF NOT EXISTS idx_clan_members_steam ON clan_members(steam_id);

  CREATE TABLE IF NOT EXISTS clan_invites (
    code       TEXT PRIMARY KEY,
    clan_id    TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at INTEGER,                        -- unix ms, NULL = never
    max_uses   INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
    uses       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_clan_invites_clan ON clan_invites(clan_id);

  CREATE TABLE IF NOT EXISTS wipe_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    wipe_ts     INTEGER,                       -- unix ms
    server_name TEXT,
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | done | cancelled
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wipe_plans_clan ON wipe_plans(clan_id);

  CREATE TABLE IF NOT EXISTS wipe_plan_rsvps (
    plan_id  INTEGER NOT NULL,
    steam_id TEXT NOT NULL,
    response TEXT NOT NULL,                    -- yes | no | maybe | late
    note     TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (plan_id, steam_id)
  );

  CREATE TABLE IF NOT EXISTS clan_member_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id    TEXT NOT NULL,
    steam_id   TEXT NOT NULL,
    text       TEXT NOT NULL,
    by_steam_id TEXT,
    by_name    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_member_notes ON clan_member_notes(clan_id, steam_id);

  CREATE TABLE IF NOT EXISTS clan_announcements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id     TEXT NOT NULL,
    text        TEXT NOT NULL,
    by_steam_id TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_announcements_clan ON clan_announcements(clan_id);

  CREATE TABLE IF NOT EXISTS clan_applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id     TEXT NOT NULL,
    steam_id    TEXT NOT NULL,
    name        TEXT,
    message     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
    decided_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_applications_clan ON clan_applications(clan_id, status);

  CREATE TABLE IF NOT EXISTS steam_profiles (
    steam_id   TEXT PRIMARY KEY,
    persona    TEXT,
    avatar     TEXT,
    vac_bans   INTEGER,
    game_bans  INTEGER,
    days_since_last_ban INTEGER,
    fetched_at INTEGER NOT NULL DEFAULT 0
  );
`);

/* Idempotent column migrations for clan_members — mirror the bot's member
   profile surface (recruitment stage, clan rank, bed + locker tracking). */
for (const [col, ddl] of [
    ['stage',          "ALTER TABLE clan_members ADD COLUMN stage TEXT"],
    ['rank',           "ALTER TABLE clan_members ADD COLUMN rank TEXT"],
    ['has_bed',        "ALTER TABLE clan_members ADD COLUMN has_bed INTEGER NOT NULL DEFAULT 0"],
    ['bed_given_at',   "ALTER TABLE clan_members ADD COLUMN bed_given_at TEXT"],
    ['has_locker',     "ALTER TABLE clan_members ADD COLUMN has_locker INTEGER NOT NULL DEFAULT 0"],
    ['locker_given_at',"ALTER TABLE clan_members ADD COLUMN locker_given_at TEXT"],
]) {
    if (!hasColumn('clan_members', col)) db.exec(ddl);
}
if (!hasColumn('clans', 'applications_open')) {
    db.exec("ALTER TABLE clans ADD COLUMN applications_open INTEGER NOT NULL DEFAULT 1");
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

    /* ── ClanBot Platform: clans (website-side Clan Manager) ────────────── */

    createClan: db.transaction(({ name, tag, ownerSteamId, ownerName }) => {
        const clanId = crypto.randomBytes(6).toString('hex');
        db.prepare(
            'INSERT INTO clans (clan_id, name, tag, owner_steam_id) VALUES (?, ?, ?, ?)'
        ).run(clanId, String(name), tag ? String(tag) : null, String(ownerSteamId));
        db.prepare(
            "INSERT INTO clan_members (clan_id, steam_id, name, role) VALUES (?, ?, ?, 'owner')"
        ).run(clanId, String(ownerSteamId), ownerName || null);
        return clanId;
    }),
    getClan(clanId) {
        return db.prepare('SELECT * FROM clans WHERE clan_id = ?').get(String(clanId));
    },
    getClanByDeployment(guildId) {
        return db.prepare('SELECT * FROM clans WHERE deployment_guild_id = ?').get(String(guildId));
    },
    updateClan(clanId, fields) {
        const allowed = ['name', 'tag', 'discord_guild_id', 'deployment_guild_id'];
        const keys = Object.keys(fields).filter(k => allowed.includes(k));
        if (!keys.length) return;
        const sets = keys.map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE clans SET ${sets} WHERE clan_id = ?`)
            .run(...keys.map(k => fields[k]), String(clanId));
    },
    getPlatformClansForSteam(steamId) {
        return db.prepare(
            `SELECT c.*, m.role AS my_role FROM clan_members m
             JOIN clans c ON c.clan_id = m.clan_id
             WHERE m.steam_id = ? ORDER BY c.created_at`
        ).all(String(steamId));
    },
    getClanRoster(clanId) {
        return db.prepare(
            `SELECT steam_id, name, role, stage, rank, has_bed, bed_given_at,
                    has_locker, locker_given_at, added_at
             FROM clan_members
             WHERE clan_id = ?
             ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'leader' THEN 1 ELSE 2 END, name COLLATE NOCASE`
        ).all(String(clanId));
    },
    getClanMemberRole(clanId, steamId) {
        const row = db.prepare(
            'SELECT role FROM clan_members WHERE clan_id = ? AND steam_id = ?'
        ).get(String(clanId), String(steamId));
        return row ? row.role : null;
    },
    addClanMember(clanId, steamId, name, role = 'member') {
        db.prepare(
            `INSERT INTO clan_members (clan_id, steam_id, name, role) VALUES (?, ?, ?, ?)
             ON CONFLICT(clan_id, steam_id) DO UPDATE SET
               name = COALESCE(excluded.name, clan_members.name)`
        ).run(String(clanId), String(steamId), name || null, String(role));
    },
    removeClanMember(clanId, steamId) {
        db.prepare('DELETE FROM clan_members WHERE clan_id = ? AND steam_id = ?')
            .run(String(clanId), String(steamId));
    },
    setClanMemberRole(clanId, steamId, role) {
        db.prepare('UPDATE clan_members SET role = ? WHERE clan_id = ? AND steam_id = ?')
            .run(String(role), String(clanId), String(steamId));
    },

    createClanInvite(clanId, createdBy, { expiresAt = null, maxUses = 0 } = {}) {
        const code = crypto.randomBytes(5).toString('hex');
        db.prepare(
            'INSERT INTO clan_invites (code, clan_id, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)'
        ).run(code, String(clanId), String(createdBy), expiresAt, Number(maxUses) || 0);
        return code;
    },
    getClanInvite(code) {
        return db.prepare('SELECT * FROM clan_invites WHERE code = ?').get(String(code));
    },
    /* Validate + consume an invite and add the member atomically. Returns
       { ok, clanId?, reason? }. Joining a clan you're in is a friendly no-op. */
    redeemClanInvite: db.transaction((code, steamId, name) => {
        const inv = db.prepare('SELECT * FROM clan_invites WHERE code = ?').get(String(code));
        if (!inv) return { ok: false, reason: 'unknown code' };
        if (inv.expires_at && Date.now() > Number(inv.expires_at)) return { ok: false, reason: 'expired' };
        if (inv.max_uses > 0 && inv.uses >= inv.max_uses) return { ok: false, reason: 'used up' };
        const existing = db.prepare(
            'SELECT 1 FROM clan_members WHERE clan_id = ? AND steam_id = ?'
        ).get(inv.clan_id, String(steamId));
        if (!existing) {
            db.prepare(
                "INSERT INTO clan_members (clan_id, steam_id, name, role) VALUES (?, ?, ?, 'member')"
            ).run(inv.clan_id, String(steamId), name || null);
            db.prepare('UPDATE clan_invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
        }
        return { ok: true, clanId: inv.clan_id };
    }),

    /* ── Wipe plans ── */
    createWipePlan(clanId, { title, wipeTs, serverName, notes, createdBy }) {
        return db.prepare(
            `INSERT INTO wipe_plans (clan_id, title, wipe_ts, server_name, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(String(clanId), String(title), wipeTs || null, serverName || null,
            notes || null, createdBy || null).lastInsertRowid;
    },
    listWipePlans(clanId) {
        return db.prepare(
            `SELECT * FROM wipe_plans WHERE clan_id = ?
             ORDER BY status = 'scheduled' DESC, wipe_ts IS NULL, wipe_ts ASC, id DESC`
        ).all(String(clanId));
    },
    getWipePlan(id) {
        return db.prepare('SELECT * FROM wipe_plans WHERE id = ?').get(Number(id));
    },
    setWipePlanStatus(id, status) {
        db.prepare('UPDATE wipe_plans SET status = ? WHERE id = ?').run(String(status), Number(id));
    },
    setWipePlanRsvp(planId, steamId, response, note) {
        db.prepare(
            `INSERT INTO wipe_plan_rsvps (plan_id, steam_id, response, note, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(plan_id, steam_id) DO UPDATE SET
               response = excluded.response, note = excluded.note, updated_at = datetime('now')`
        ).run(Number(planId), String(steamId), String(response), note || null);
    },
    getWipePlanRsvps(planId) {
        return db.prepare(
            'SELECT steam_id, response, note, updated_at FROM wipe_plan_rsvps WHERE plan_id = ?'
        ).all(Number(planId));
    },

    /* ── Member profile fields (bot Clan Manager parity) ── */
    setClanMemberStage(clanId, steamId, stage) {
        db.prepare('UPDATE clan_members SET stage = ? WHERE clan_id = ? AND steam_id = ?')
            .run(stage || null, String(clanId), String(steamId));
    },
    setClanMemberRank(clanId, steamId, rank) {
        db.prepare('UPDATE clan_members SET rank = ? WHERE clan_id = ? AND steam_id = ?')
            .run(rank || null, String(clanId), String(steamId));
    },
    setClanMemberFlag(clanId, steamId, field, value) {
        const col = field === 'bed' ? 'has_bed' : 'has_locker';
        const at  = field === 'bed' ? 'bed_given_at' : 'locker_given_at';
        db.prepare(
            `UPDATE clan_members SET ${col} = ?, ${at} = CASE WHEN ? THEN datetime('now') ELSE NULL END
             WHERE clan_id = ? AND steam_id = ?`
        ).run(value ? 1 : 0, value ? 1 : 0, String(clanId), String(steamId));
    },

    addClanMemberNote(clanId, steamId, text, bySteamId, byName) {
        return db.prepare(
            `INSERT INTO clan_member_notes (clan_id, steam_id, text, by_steam_id, by_name)
             VALUES (?, ?, ?, ?, ?)`
        ).run(String(clanId), String(steamId), String(text), bySteamId || null, byName || null).lastInsertRowid;
    },
    listClanMemberNotes(clanId, steamId, limit = 50) {
        return db.prepare(
            `SELECT id, text, by_steam_id, by_name, created_at FROM clan_member_notes
             WHERE clan_id = ? AND steam_id = ? ORDER BY id DESC LIMIT ?`
        ).all(String(clanId), String(steamId), Number(limit));
    },

    postClanAnnouncement(clanId, text, bySteamId) {
        return db.prepare(
            'INSERT INTO clan_announcements (clan_id, text, by_steam_id) VALUES (?, ?, ?)'
        ).run(String(clanId), String(text), bySteamId || null).lastInsertRowid;
    },
    listClanAnnouncements(clanId, limit = 5) {
        return db.prepare(
            `SELECT id, text, by_steam_id, created_at FROM clan_announcements
             WHERE clan_id = ? ORDER BY id DESC LIMIT ?`
        ).all(String(clanId), Number(limit));
    },

    /* ── Applications (recruitment pipeline) ── */
    createClanApplication(clanId, steamId, name, message) {
        /* One live application per applicant per clan. */
        const existing = db.prepare(
            "SELECT id FROM clan_applications WHERE clan_id = ? AND steam_id = ? AND status = 'pending'"
        ).get(String(clanId), String(steamId));
        if (existing) return existing.id;
        return db.prepare(
            'INSERT INTO clan_applications (clan_id, steam_id, name, message) VALUES (?, ?, ?, ?)'
        ).run(String(clanId), String(steamId), name || null, message || null).lastInsertRowid;
    },
    listClanApplications(clanId, status = 'pending') {
        return db.prepare(
            `SELECT * FROM clan_applications WHERE clan_id = ? AND status = ?
             ORDER BY id DESC LIMIT 100`
        ).all(String(clanId), String(status));
    },
    getClanApplication(id) {
        return db.prepare('SELECT * FROM clan_applications WHERE id = ?').get(Number(id));
    },
    /* Approve adds the member (stage 'trial' — the bot's post-applicant tier). */
    decideClanApplication: db.transaction((id, approve, decidedBy) => {
        const app = db.prepare('SELECT * FROM clan_applications WHERE id = ?').get(Number(id));
        if (!app || app.status !== 'pending') return null;
        db.prepare(
            "UPDATE clan_applications SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?"
        ).run(approve ? 'approved' : 'denied', decidedBy || null, app.id);
        if (approve) {
            db.prepare(
                `INSERT INTO clan_members (clan_id, steam_id, name, role, stage)
                 VALUES (?, ?, ?, 'member', 'trial')
                 ON CONFLICT(clan_id, steam_id) DO NOTHING`
            ).run(app.clan_id, app.steam_id, app.name);
        }
        return app;
    }),
    setClanApplicationsOpen(clanId, open) {
        db.prepare('UPDATE clans SET applications_open = ? WHERE clan_id = ?')
            .run(open ? 1 : 0, String(clanId));
    },

    /* ── Steam profile cache (names, avatars, ban vetting) ── */
    getSteamProfiles(steamIds) {
        if (!steamIds.length) return [];
        const q = steamIds.map(() => '?').join(',');
        return db.prepare(`SELECT * FROM steam_profiles WHERE steam_id IN (${q})`).all(...steamIds.map(String));
    },
    upsertSteamProfile({ steamId, persona, avatar, vacBans, gameBans, daysSinceLastBan }) {
        db.prepare(
            `INSERT INTO steam_profiles (steam_id, persona, avatar, vac_bans, game_bans, days_since_last_ban, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(steam_id) DO UPDATE SET
               persona = COALESCE(excluded.persona, steam_profiles.persona),
               avatar  = COALESCE(excluded.avatar, steam_profiles.avatar),
               vac_bans = COALESCE(excluded.vac_bans, steam_profiles.vac_bans),
               game_bans = COALESCE(excluded.game_bans, steam_profiles.game_bans),
               days_since_last_ban = COALESCE(excluded.days_since_last_ban, steam_profiles.days_since_last_ban),
               fetched_at = excluded.fetched_at`
        ).run(String(steamId), persona ?? null, avatar ?? null, vacBans ?? null, gameBans ?? null,
            daysSinceLastBan ?? null, Date.now());
    },

    /* Bridge: materialize/refresh a platform clan from a deployment's roster
       push, so every existing bot customer appears in the Clan Manager on day
       one. Deployment roles map hoster→owner, else pass through. The
       deployment stays authoritative for bridged rosters (full replace),
       matching replaceRoster semantics. */
    bridgeDeploymentClan: db.transaction((guildId, clanName, members) => {
        const gid = String(guildId);
        const list = (members || []).filter(m => m && m.steamId);
        const hoster = list.find(m => m.role === 'hoster');
        const owner = hoster ? hoster.steamId : (list[0] && list[0].steamId);
        if (!owner) return null;

        let clan = db.prepare('SELECT * FROM clans WHERE deployment_guild_id = ?').get(gid);
        if (!clan) {
            const clanId = crypto.randomBytes(6).toString('hex');
            db.prepare(
                'INSERT INTO clans (clan_id, name, owner_steam_id, deployment_guild_id) VALUES (?, ?, ?, ?)'
            ).run(clanId, clanName || 'My Clan', String(owner), gid);
            clan = { clan_id: clanId };
        } else if (clanName) {
            db.prepare('UPDATE clans SET name = ? WHERE clan_id = ?').run(clanName, clan.clan_id);
        }

        /* Upsert members WITHOUT touching platform-side profile fields
           (stage, rank, bed/locker, notes) — a full replace would wipe them on
           every 10-minute roster push. Members absent from the push are
           removed (the deployment is authoritative for WHO is in the clan). */
        const ins = db.prepare(
            `INSERT INTO clan_members (clan_id, steam_id, name, role) VALUES (?, ?, ?, ?)
             ON CONFLICT(clan_id, steam_id) DO UPDATE SET
               role = excluded.role,
               name = COALESCE(excluded.name, clan_members.name)`
        );
        const pushed = new Set();
        for (const m of list) {
            const role = m.role === 'hoster' ? 'owner' : (m.role === 'leader' ? 'leader' : 'member');
            ins.run(clan.clan_id, String(m.steamId), m.name || null, role);
            pushed.add(String(m.steamId));
        }
        const current = db.prepare('SELECT steam_id FROM clan_members WHERE clan_id = ?').all(clan.clan_id);
        const del = db.prepare('DELETE FROM clan_members WHERE clan_id = ? AND steam_id = ?');
        for (const row of current) {
            if (!pushed.has(row.steam_id)) del.run(clan.clan_id, row.steam_id);
        }
        return clan.clan_id;
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
