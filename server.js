'use strict';

// Load config from a .env file in the app root if one exists (Plesk / bare Node).
// override:true makes the file authoritative so it beats a stale value from the
// host's env-var UI. In Docker there's no .env file, so the container env is used.
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DB      = require('./db');
const Pelican = require('./pelican');
const Mailer  = require('./mailer');

// Plesk/Passenger sets PORT; fall back to SALES_PORT (Docker) then 4000.
const PORT          = parseInt(process.env.PORT || process.env.SALES_PORT || '4000', 10);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WHSEC  = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID      = process.env.STRIPE_PRICE_ID;        // monthly recurring price
const SUCCESS_URL   = process.env.SUCCESS_URL || `http://localhost:${PORT}/success`;
const CANCEL_URL    = process.env.CANCEL_URL  || `http://localhost:${PORT}/`;
const BILLING_PORTAL_RETURN_URL = process.env.BILLING_PORTAL_RETURN_URL || `${process.env.SALES_URL || `http://localhost:${PORT}`}/account`;
const ADMIN_TOKEN   = (() => {
    // .trim() guards against a stray space/newline pasted into the host's env UI.
    if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
    // Never fall back to random value - require explicit token in production
    throw new Error(
        '[FATAL] ADMIN_TOKEN must be set in .env for production security. ' +
        'Cannot fall back to insecure defaults.'
    );
})();
const PUBLIC_DIR    = path.join(__dirname, 'public');
const SALES_URL     = process.env.SALES_URL || `http://localhost:${PORT}`;
/* Secret for the signed Steam cookie. Falls back to ADMIN_TOKEN (always set)
   so the cookie is still tamper-proof even if SALES_SESSION_SECRET is unset. */
const SESSION_SECRET = process.env.SALES_SESSION_SECRET || ADMIN_TOKEN;
const STEAM_COOKIE  = 'sales_steam';
const STEAM_TTL_MS  = 60 * 60 * 1000; /* 1 hour to complete checkout */

/* Clanbot Accounts: shared secret bot deployments use to sign roster pushes
   and that we use to sign SSO handoff tokens. Must match the bot's
   CLANBOT_ACCOUNT_SECRET. Empty = the cross-clan account feature is disabled
   (roster ingestion + SSO respond 503). Never falls back to ADMIN_TOKEN — the
   value has to be identical on BOTH services, so it must be set explicitly. */
const ACCOUNT_SECRET = (process.env.CLANBOT_ACCOUNT_SECRET || '').trim();
const SSO_TTL_MS     = 120 * 1000; /* SSO handoff token lifetime */
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const PAST_DUE_SUB_STATUSES = new Set(['past_due', 'unpaid']);
const CANCELED_SUB_STATUSES = new Set(['canceled', 'incomplete_expired']);

function stripeTs(ts) {
    if (!ts) return null;
    return new Date(Number(ts) * 1000).toISOString();
}

function normalizeSubStatus(subStatus, fallback = 'active') {
    const s = String(subStatus || '').toLowerCase();
    if (ACTIVE_SUB_STATUSES.has(s)) return fallback;
    if (PAST_DUE_SUB_STATUSES.has(s)) return 'past_due';
    if (CANCELED_SUB_STATUSES.has(s)) return 'suspended';
    return fallback;
}

/* ── Stripe thin client (no npm, raw HTTPS) ─────────────────────────── */
function stripePost(endpoint, params) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const req = https.request({
            hostname: 'api.stripe.com',
            path: `/v1/${endpoint}`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${STRIPE_SECRET}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const json = JSON.parse(data);
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                else reject(new Error(`Stripe ${endpoint} ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function stripeGet(endpoint) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.stripe.com',
            path: `/v1/${endpoint}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const json = JSON.parse(data);
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                else reject(new Error(`Stripe GET ${endpoint} ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/* ── Steam OpenID verify (raw HTTPS POST, no SDK) ────────────────────── */
function steamVerifyPost(params) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const req = https.request({
            hostname: 'steamcommunity.com',
            path: '/openid/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/* ── Idempotency mutex: chains concurrent calls per order key ─────────── */
const provisionLocks = new Map();

/* ── Provisioning ────────────────────────────────────────────────────── */
async function provisionOrder(orderId, eventId) {
    /* Fast-path: already processed this exact event */
    if (eventId && DB.getProcessedEvent(eventId)) {
        console.log(`[provision] Event ${eventId} already processed — skipping`);
        return;
    }

    /* In-process mutex: serialize concurrent calls for the same order */
    const lockKey = `order:${orderId}`;
    const prev = provisionLocks.get(lockKey) || Promise.resolve();
    let release;
    const current = prev.then(() => new Promise(r => { release = r; }));
    provisionLocks.set(lockKey, current.catch(() => {}));

    try {
        await prev; /* wait for any prior call to finish */

        const order = DB.getOrder(orderId);
        if (!order) throw new Error('Order not found');

        /* Atomic reserve: idempotency + race protection in one transaction */
        const reserved = DB.reserveResourcesForOrder(orderId, eventId || `manual:${orderId}:${Date.now()}`);
        if (reserved.alreadyDone) {
            console.log(`[provision] Order ${orderId} already provisioned — skipping`);
            return;
        }

        const { port, token: tokenRow } = reserved;

        const { serverId, identifier, setupUrl } = await Pelican.createServer({
            orderId,
            customerEmail: order.customer_email,
            port,
            discordToken: tokenRow.bot_token,
            discordClientId: tokenRow.client_id,
        });

        DB.updateOrder(orderId, {
            status: 'active',
            pelican_server_id: serverId,
            pelican_identifier: identifier || null,
            setup_url: setupUrl,
            provisioned_at: new Date().toISOString(),
        });

        /* The bot is already provisioned at this point — a failed setup email
           (e.g. SMTP not configured) must NOT roll the order back to failed. */
        try {
            await Mailer.sendProvisionedEmail({
                to: order.customer_email,
                name: order.customer_name,
                setupUrl,
                orderId,
            });
        } catch (e) {
            console.error(`[provision] order ${orderId} provisioned, but setup email failed:`, e.message);
        }

        console.log(`[provision] Order ${orderId} → port ${port}, server ${serverId}`);
    } finally {
        if (release) release();
        if (provisionLocks.get(lockKey) === current) provisionLocks.delete(lockKey);
    }
}

/* ── Request helpers ─────────────────────────────────────────────────── */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function serveFile(res, filePath, contentType) {
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

function isAdmin(req) {
    const auth = req.headers['authorization'] || '';
    const cookie = parseCookies(req)['admin_session'] || '';
    return auth === `Bearer ${ADMIN_TOKEN}` || cookie === ADMIN_TOKEN;
}

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) out[k.trim()] = v.join('=').trim();
    });
    return out;
}

/* ── Steam session cookie (HMAC-signed, short-lived) ─────────────────── */
function signSteam(steamId) {
    const payload = Buffer.from(JSON.stringify({ steamId, iat: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifySteam(req) {
    const raw = parseCookies(req)[STEAM_COOKIE];
    if (!raw) return null;
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!data.steamId || Date.now() - data.iat > STEAM_TTL_MS) return null;
        return String(data.steamId);
    } catch { return null; }
}

/* ── Clanbot Accounts: shared-secret HMAC (roster push + SSO handoff) ──── */
/* The secret that governs a given deployment: its own per-deployment secret
   if provisioning set one, else the global ACCOUNT_SECRET. Both this service
   and the bot resolve to the same value. */
function getSigningSecret(guildId) {
    const dep = guildId ? DB.getDeployment(guildId) : null;
    return (dep && dep.shared_secret) || ACCOUNT_SECRET;
}

/* A deployment's dashboard URL must be absolute — a scheme-less value (bare
   IP/host) would make the SSO redirect relative to THIS site and 404. Repair
   rather than reject: prepend https:// when the scheme is missing. */
function absDashboardUrl(u) {
    u = String(u || '').trim().replace(/\/$/, '');
    if (!u) return null;
    if (!u.includes('://')) u = 'https://' + u;
    return u;
}

/* Constant-time verify of `HMAC_SHA256(secret, timestamp + '.' + rawBody)`
   presented as a hex string. Mirrors the Stripe-webhook verification style. */
function verifyClanbotSig(secret, timestamp, rawBody, sigHex) {
    if (!secret || !timestamp || !sigHex) return false;
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(String(sigHex), 'hex'), Buffer.from(expected, 'hex'));
    } catch { return false; }
}

/* ── Route: POST /api/roster — a bot deployment reports its member roster ─ */
async function handleRoster(req, res) {
    if (!ACCOUNT_SECRET) return json(res, 503, { error: 'accounts feature disabled' });

    const raw = (await readBody(req)).toString();
    const ts  = req.headers['x-clanbot-ts'];
    const sig = req.headers['x-clanbot-sig'];
    if (!ts || !sig) return json(res, 401, { error: 'unsigned' });
    /* Replay window: ±5 minutes. */
    if (!/^\d+$/.test(String(ts)) || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) {
        return json(res, 401, { error: 'stale timestamp' });
    }

    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
    const guildId = String(body.guildId || '').trim();
    if (!guildId) return json(res, 400, { error: 'missing guildId' });

    /* TOFU: first push from a guild has no per-deployment secret yet, so it is
       verified against the global ACCOUNT_SECRET; the deployment row is then
       created. Once provisioning sets a per-deployment secret, that governs. */
    const secret = getSigningSecret(guildId);
    if (!verifyClanbotSig(secret, ts, raw, sig)) return json(res, 401, { error: 'bad signature' });

    const members = Array.isArray(body.members) ? body.members : [];
    DB.upsertDeployment({ guildId, clanName: body.clanName, dashboardUrl: absDashboardUrl(body.dashboardUrl) });
    DB.replaceRoster(guildId, members);
    /* Materialize/refresh the platform-side clan record so deployment-backed
       clans appear in the website Clan Manager automatically. */
    try { DB.bridgeDeploymentClan(guildId, body.clanName, members); } catch (e) {
        console.warn('[roster] clan bridge failed:', e.message);
    }
    return json(res, 200, { ok: true, count: members.length });
}

/* Mint a short-lived, single-use SSO handoff token for a specific clan. The
   bot deployment verifies it with the same secret, then re-derives the role
   locally before minting its own session — so this token is a capability to
   *attempt* login, never an authority on membership. */
function mintSsoToken({ steamId, guildId, role }) {
    const secret = getSigningSecret(guildId);
    const payload = Buffer.from(JSON.stringify({
        steamId: String(steamId),
        guildId: String(guildId),
        role: String(role || 'member'),
        nonce: crypto.randomBytes(12).toString('hex'),
        exp: Date.now() + SSO_TTL_MS,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

/* ── Route: GET /api/clans — clans the signed-in member belongs to ─────── */
async function handleClans(req, res) {
    const steamId = verifySteam(req);
    if (!steamId) return json(res, 401, { error: 'sign in with Steam first' });
    const clans = DB.getClansForSteam(steamId).map(c => ({
        guildId: c.guild_id,
        clanName: c.clan_name || 'Unnamed clan',
        role: c.role,
        lastSeen: c.last_seen,
        /* Entry always goes through the SSO launcher — never expose the raw
           dashboard URL, and never let the browser pick the guild for SSO. */
        enterUrl: `/sso/launch?guild_id=${encodeURIComponent(c.guild_id)}`,
    }));
    return json(res, 200, { steamId, clans });
}

/* ── Route: GET /sso/launch?guild_id= — hand the member off to a clan ──── */
async function handleSsoLaunch(req, res) {
    if (!ACCOUNT_SECRET) return json(res, 503, { error: 'accounts feature disabled' });
    const steamId = verifySteam(req);
    if (!steamId) return redirect(res, '/account?steam=needlogin');

    const u = new URL(req.url, SALES_URL);
    const guildId = String(u.searchParams.get('guild_id') || '').trim();
    if (!guildId) return json(res, 400, { error: 'missing guild_id' });

    const dep = DB.getDeployment(guildId);
    if (!dep || !dep.dashboard_url) return json(res, 404, { error: 'unknown clan' });
    if (!DB.isMemberOf(steamId, guildId)) return json(res, 403, { error: 'not a member of that clan' });

    const membership = DB.getClansForSteam(steamId).find(c => c.guild_id === guildId);
    const token = mintSsoToken({ steamId, guildId, role: membership ? membership.role : 'member' });
    /* absDashboardUrl repairs any legacy scheme-less rows so the redirect is
       always absolute (a relative Location would 404 against this site). */
    const target = `${absDashboardUrl(dep.dashboard_url)}/sso?token=${encodeURIComponent(token)}`;
    return redirect(res, target);
}

/* ── Route: POST /api/clans-lookup — server-to-server directory lookup ───
   Lets a bot deployment fetch the clans a steamId belongs to so it can render
   an inline "my clans" switcher on its own dashboard. Authenticated by the
   shared secret (HMAC), NOT a member cookie — the caller is a trusted
   deployment, not the browser. Not guild-scoped, so it verifies against the
   global ACCOUNT_SECRET. */
async function handleClansLookup(req, res) {
    if (!ACCOUNT_SECRET) return json(res, 503, { error: 'accounts feature disabled' });

    const raw = (await readBody(req)).toString();
    const ts  = req.headers['x-clanbot-ts'];
    const sig = req.headers['x-clanbot-sig'];
    if (!ts || !sig) return json(res, 401, { error: 'unsigned' });
    if (!/^\d+$/.test(String(ts)) || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) {
        return json(res, 401, { error: 'stale timestamp' });
    }
    if (!verifyClanbotSig(ACCOUNT_SECRET, ts, raw, sig)) return json(res, 401, { error: 'bad signature' });

    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
    const steamId = String(body.steamId || '').trim();
    if (!steamId) return json(res, 400, { error: 'missing steamId' });

    const clans = DB.getClansForSteam(steamId).map(c => ({
        guildId: c.guild_id,
        clanName: c.clan_name || 'Unnamed clan',
        role: c.role,
        dashboardUrl: absDashboardUrl(c.dashboard_url),
    }));
    return json(res, 200, { clans });
}

/* ── Steam profile enrichment (names, avatars, ban vetting) ──────────────
   Trimmed port of the bot's steamAudit: batch GetPlayerSummaries +
   GetPlayerBans behind a 6-hour SQLite cache. Degrades gracefully — without
   STEAM_API_KEY the platform still works, just without names/avatars/vetting. */
const STEAM_API_KEY = (process.env.STEAM_API_KEY || process.env.STEAM_WEB_API_KEY || '').trim();
const STEAM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function steamGetJson(url) {
    return new Promise((resolve) => {
        https.get(url, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

/* Returns { steamId: {persona, avatar, vac_bans, game_bans, days_since_last_ban} }
   from cache, refreshing stale/missing entries when a key is configured. */
async function steamProfiles(steamIds) {
    const ids = [...new Set(steamIds.map(String).filter(s => /^\d{17}$/.test(s)))];
    if (!ids.length) return {};
    const out = {};
    const now = Date.now();
    const stale = [];
    for (const row of DB.getSteamProfiles(ids)) {
        out[row.steam_id] = row;
        if (now - (row.fetched_at || 0) > STEAM_CACHE_TTL_MS) stale.push(row.steam_id);
    }
    const missing = ids.filter(id => !out[id]);
    const toFetch = [...missing, ...stale].slice(0, 100);

    if (STEAM_API_KEY && toFetch.length) {
        const idsParam = toFetch.join(',');
        const [sumRes, banRes] = await Promise.all([
            steamGetJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${idsParam}`),
            steamGetJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${idsParam}`),
        ]);
        const sums = new Map((sumRes?.response?.players || []).map(p => [String(p.steamid), p]));
        const bans = new Map((banRes?.players || []).map(p => [String(p.SteamId), p]));
        for (const id of toFetch) {
            const s = sums.get(id), b = bans.get(id);
            if (!s && !b) continue;
            const profile = {
                steamId: id,
                persona: s?.personaname ?? null,
                avatar: s?.avatarfull || s?.avatarmedium || s?.avatar || null,
                vacBans: b ? Number(b.NumberOfVACBans || 0) : null,
                gameBans: b ? Number(b.NumberOfGameBans || 0) : null,
                daysSinceLastBan: b ? Number(b.DaysSinceLastBan || 0) : null,
            };
            try { DB.upsertSteamProfile(profile); } catch (_) {}
            out[id] = {
                steam_id: id, persona: profile.persona, avatar: profile.avatar,
                vac_bans: profile.vacBans, game_bans: profile.gameBans,
                days_since_last_ban: profile.daysSinceLastBan, fetched_at: now,
            };
        }
    }
    return out;
}

/* ── ClanBot Platform: /api/myclan/* — the website-side Clan Manager ─────
   Steam-cookie auth (verifySteam). A member may belong to several platform
   clans; write operations take clanId and are role-checked against
   clan_members (owner > leader > member). */
const CAN_LEAD = new Set(['owner', 'leader']);

async function handleMyClanApi(req, res, requestUrl) {
    const steamId = verifySteam(req);
    if (!steamId) return json(res, 401, { error: 'sign in with Steam first' });
    const pathname = requestUrl.pathname;

    const roleIn = (clanId) => DB.getClanMemberRole(clanId, steamId);
    const requireLead = (clanId) => {
        const role = roleIn(clanId);
        if (!role) return { fail: () => json(res, 404, { error: 'not your clan' }) };
        if (!CAN_LEAD.has(role)) return { fail: () => json(res, 403, { error: 'leaders only' }) };
        return { role };
    };
    const body = req.method === 'POST'
        ? await readBody(req).then(b => { try { return JSON.parse(b.toString() || '{}'); } catch { return null; } })
        : null;
    if (req.method === 'POST' && body === null) return json(res, 400, { error: 'bad json' });

    /* GET /api/myclan[?clan=id] — my clans + the selected clan in full */
    if (pathname === '/api/myclan' && req.method === 'GET') {
        const mine = DB.getPlatformClansForSteam(steamId);
        const selId = requestUrl.searchParams.get('clan') || (mine[0] && mine[0].clan_id);
        let clan = null;
        if (selId && mine.some(c => c.clan_id === selId)) {
            const c = DB.getClan(selId);
            const myRole = roleIn(selId);
            const roster = DB.getClanRoster(selId);
            const wipes = DB.listWipePlans(selId).map(w => ({
                ...w, rsvps: DB.getWipePlanRsvps(w.id),
            }));
            /* Live Rust+ team ("Active clan") — read-only, transient. */
            const live = c.deployment_guild_id ? DB.getDeploymentRoster(c.deployment_guild_id) : [];
            /* Steam enrichment: names/avatars for roster + RSVP + live display. */
            const allIds = [...new Set([
                ...roster.map(m => m.steam_id),
                ...wipes.flatMap(w => w.rsvps.map(r => r.steam_id)),
                ...live.slice(0, 500).map(r => r.steam_id),
            ])];
            const profiles = await steamProfiles(allIds).catch(() => ({}));
            const inClan = new Set(roster.map(m => m.steam_id));
            const activeRoster = live.slice(0, 500).map(r => ({
                steamId: r.steam_id,
                role: r.role,
                inClan: inClan.has(r.steam_id),
                persona: profiles[r.steam_id]?.persona ?? null,
                avatar: profiles[r.steam_id]?.avatar ?? null,
            }));
            clan = {
                clanId: c.clan_id, name: c.name, tag: c.tag,
                deploymentGuildId: c.deployment_guild_id,
                applicationsOpen: !!c.applications_open,
                applyUrl: `${SALES_URL}/apply/${c.clan_id}`,
                myRole,
                roster: roster.map(m => ({
                    ...m,
                    persona: profiles[m.steam_id]?.persona ?? null,
                    avatar: profiles[m.steam_id]?.avatar ?? null,
                })),
                activeRoster,
                activeTotal: live.length,
                wipes,
                profiles: Object.fromEntries(Object.entries(profiles).map(([id, p]) =>
                    [id, { persona: p.persona, avatar: p.avatar }])),
                announcements: DB.listClanAnnouncements(selId, 5),
                pendingApplications: CAN_LEAD.has(myRole)
                    ? DB.listClanApplications(selId, 'pending').length : 0,
            };
        }
        return json(res, 200, {
            steamId,
            clans: mine.map(c => ({ clanId: c.clan_id, name: c.name, tag: c.tag, myRole: c.my_role })),
            clan,
        });
    }

    /* ── Member profile ops (bot Clan Manager parity) ── */
    if (pathname === '/api/myclan/member/stage' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const stage = String(body.stage || '');
        if (stage && !['applicant', 'trial', 'member', 'departed'].includes(stage)) {
            return json(res, 400, { error: 'bad stage' });
        }
        DB.setClanMemberStage(body.clanId, String(body.steamId || ''), stage || null);
        return json(res, 200, { ok: true });
    }
    if (pathname === '/api/myclan/member/rank' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const rank = String(body.rank || '');
        if (rank && !['leader', 'officer', 'member', 'recruit'].includes(rank)) {
            return json(res, 400, { error: 'bad rank' });
        }
        DB.setClanMemberRank(body.clanId, String(body.steamId || ''), rank || null);
        return json(res, 200, { ok: true });
    }
    if (pathname === '/api/myclan/member/flag' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const field = String(body.field || '');
        if (!['bed', 'locker'].includes(field)) return json(res, 400, { error: 'field must be bed or locker' });
        DB.setClanMemberFlag(body.clanId, String(body.steamId || ''), field, !!body.value);
        return json(res, 200, { ok: true });
    }
    if (pathname === '/api/myclan/member/notes' && req.method === 'GET') {
        const clanId = requestUrl.searchParams.get('clan') || '';
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const target = requestUrl.searchParams.get('steamId') || '';
        return json(res, 200, { notes: DB.listClanMemberNotes(clanId, target) });
    }
    if (pathname === '/api/myclan/member/note' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'note text required' });
        DB.addClanMemberNote(body.clanId, String(body.steamId || ''), text.slice(0, 1000), steamId, body.byName || null);
        return json(res, 200, { ok: true });
    }

    /* ── Announcements ── */
    if (pathname === '/api/myclan/announce' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'announcement text required' });
        DB.postClanAnnouncement(body.clanId, text.slice(0, 2000), steamId);
        return json(res, 200, { ok: true });
    }

    /* ── Applications (recruitment pipeline + Steam vetting) ── */
    if (pathname === '/api/myclan/applications' && req.method === 'GET') {
        const clanId = requestUrl.searchParams.get('clan') || '';
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const apps = DB.listClanApplications(clanId, requestUrl.searchParams.get('status') || 'pending');
        const profiles = await steamProfiles(apps.map(a => a.steam_id)).catch(() => ({}));
        return json(res, 200, {
            applications: apps.map(a => ({
                ...a,
                persona: profiles[a.steam_id]?.persona ?? null,
                avatar: profiles[a.steam_id]?.avatar ?? null,
                vacBans: profiles[a.steam_id]?.vac_bans ?? null,
                gameBans: profiles[a.steam_id]?.game_bans ?? null,
                daysSinceLastBan: profiles[a.steam_id]?.days_since_last_ban ?? null,
            })),
            vettingEnabled: !!STEAM_API_KEY,
        });
    }
    if (pathname === '/api/myclan/applications/decide' && req.method === 'POST') {
        const app = DB.getClanApplication(Number(body.id || 0));
        if (!app) return json(res, 404, { error: 'no such application' });
        const gate = requireLead(app.clan_id); if (gate.fail) return gate.fail();
        const decided = DB.decideClanApplication(app.id, !!body.approve, steamId);
        if (!decided) return json(res, 409, { error: 'already decided' });
        return json(res, 200, { ok: true });
    }
    if (pathname === '/api/myclan/applications/open' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        DB.setClanApplicationsOpen(body.clanId, !!body.open);
        return json(res, 200, { ok: true });
    }
    /* Public apply — any signed-in Steam user, no membership required. */
    if (pathname === '/api/myclan/apply' && req.method === 'POST') {
        const clan = DB.getClan(String(body.clanId || ''));
        if (!clan) return json(res, 404, { error: 'no such clan' });
        if (!clan.applications_open) return json(res, 403, { error: 'applications are closed' });
        if (DB.getClanMemberRole(clan.clan_id, steamId)) return json(res, 400, { error: 'already a member' });
        const id = DB.createClanApplication(clan.clan_id, steamId,
            body.name ? String(body.name).slice(0, 48) : null,
            body.message ? String(body.message).slice(0, 1000) : null);
        return json(res, 200, { ok: true, id, clanName: clan.name });
    }
    /* Public clan card for the apply page (name only — no roster leak). */
    if (pathname === '/api/myclan/applyinfo' && req.method === 'GET') {
        const clan = DB.getClan(requestUrl.searchParams.get('clan') || '');
        if (!clan) return json(res, 404, { error: 'no such clan' });
        return json(res, 200, {
            clanId: clan.clan_id, name: clan.name, tag: clan.tag,
            open: !!clan.applications_open,
            alreadyMember: !!DB.getClanMemberRole(clan.clan_id, steamId),
        });
    }

    if (pathname === '/api/myclan/create' && req.method === 'POST') {
        const name = String(body.name || '').trim();
        if (!name || name.length > 48) return json(res, 400, { error: 'clan name required (max 48 chars)' });
        const tag = body.tag ? String(body.tag).trim().slice(0, 8) : null;
        const clanId = DB.createClan({ name, tag, ownerSteamId: steamId, ownerName: body.ownerName || null });
        return json(res, 200, { ok: true, clanId });
    }

    if (pathname === '/api/myclan/member/add' && req.method === 'POST') {
        const gate = requireLead(String(body.clanId || '')); if (gate.fail) return gate.fail();
        const sid = String(body.steamId || '').trim();
        if (!/^\d{17}$/.test(sid)) return json(res, 400, { error: 'steamId must be a 17-digit SteamID64' });
        DB.addClanMember(body.clanId, sid, body.name ? String(body.name).slice(0, 48) : null);
        return json(res, 200, { ok: true });
    }

    /* Promote the whole live Rust+ team into the curated roster in one click —
       an EXPLICIT leader action (never automatic), with the count surfaced in
       the UI so nobody imports a merge-raid team by accident. */
    if (pathname === '/api/myclan/import-active' && req.method === 'POST') {
        const clanId = String(body.clanId || '');
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const c = DB.getClan(clanId);
        if (!c || !c.deployment_guild_id) return json(res, 400, { error: 'no linked Rust+ deployment' });
        const live = DB.getDeploymentRoster(c.deployment_guild_id);
        const cached = Object.fromEntries(DB.getSteamProfiles(live.map(r => r.steam_id)).map(p => [p.steam_id, p]));
        const added = DB.bulkAddClanMembers(clanId, live.map(r => ({
            steamId: r.steam_id, name: cached[r.steam_id]?.persona || null,
        })));
        return json(res, 200, { ok: true, added });
    }

    if (pathname === '/api/myclan/member/remove' && req.method === 'POST') {
        const clanId = String(body.clanId || '');
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const targetRole = DB.getClanMemberRole(clanId, String(body.steamId || ''));
        if (targetRole === 'owner') return json(res, 403, { error: 'cannot remove the owner' });
        if (targetRole === 'leader' && gate.role !== 'owner') return json(res, 403, { error: 'only the owner can remove a leader' });
        DB.removeClanMember(clanId, String(body.steamId || ''));
        return json(res, 200, { ok: true });
    }

    if (pathname === '/api/myclan/member/role' && req.method === 'POST') {
        const clanId = String(body.clanId || '');
        if (roleIn(clanId) !== 'owner') return json(res, 403, { error: 'owner only' });
        const role = String(body.role || '');
        if (!['leader', 'member'].includes(role)) return json(res, 400, { error: 'role must be leader or member' });
        if (DB.getClanMemberRole(clanId, String(body.steamId || '')) === 'owner') {
            return json(res, 403, { error: 'cannot change the owner role' });
        }
        DB.setClanMemberRole(clanId, String(body.steamId || ''), role);
        return json(res, 200, { ok: true });
    }

    if (pathname === '/api/myclan/invite' && req.method === 'POST') {
        const clanId = String(body.clanId || '');
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const hours = Number(body.expiresHours || 0);
        const code = DB.createClanInvite(clanId, steamId, {
            expiresAt: hours > 0 ? Date.now() + hours * 3600 * 1000 : null,
            maxUses: Number(body.maxUses || 0),
        });
        return json(res, 200, { ok: true, code, url: `${SALES_URL}/join/${code}` });
    }

    if (pathname === '/api/myclan/join' && req.method === 'POST') {
        const result = DB.redeemClanInvite(String(body.code || ''), steamId, body.name || null);
        if (!result.ok) return json(res, 400, { error: `invite ${result.reason}` });
        return json(res, 200, { ok: true, clanId: result.clanId });
    }

    if (pathname === '/api/myclan/wipes' && req.method === 'POST') {
        const clanId = String(body.clanId || '');
        const gate = requireLead(clanId); if (gate.fail) return gate.fail();
        const title = String(body.title || '').trim();
        if (!title) return json(res, 400, { error: 'title required' });
        const id = DB.createWipePlan(clanId, {
            title: title.slice(0, 80),
            wipeTs: body.wipeTs ? Number(body.wipeTs) : null,
            serverName: body.serverName ? String(body.serverName).slice(0, 80) : null,
            notes: body.notes ? String(body.notes).slice(0, 2000) : null,
            createdBy: steamId,
        });
        return json(res, 200, { ok: true, id });
    }

    if (pathname === '/api/myclan/wipes/rsvp' && req.method === 'POST') {
        const plan = DB.getWipePlan(Number(body.planId || 0));
        if (!plan || !roleIn(plan.clan_id)) return json(res, 404, { error: 'not your clan' });
        const response = String(body.response || '');
        if (!['yes', 'no', 'maybe', 'late'].includes(response)) return json(res, 400, { error: 'bad response' });
        DB.setWipePlanRsvp(plan.id, steamId, response, body.note ? String(body.note).slice(0, 300) : null);
        return json(res, 200, { ok: true });
    }

    if (pathname === '/api/myclan/wipes/status' && req.method === 'POST') {
        const plan = DB.getWipePlan(Number(body.planId || 0));
        if (!plan) return json(res, 404, { error: 'no such wipe' });
        const gate = requireLead(plan.clan_id); if (gate.fail) return gate.fail();
        const status = String(body.status || '');
        if (!['scheduled', 'done', 'cancelled'].includes(status)) return json(res, 400, { error: 'bad status' });
        DB.setWipePlanStatus(plan.id, status);
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'unknown myclan endpoint' });
}

/* ── Route: GET /auth/steam — kick off Steam OpenID ──────────────────── */
function handleSteamLogin(req, res) {
    const steamUrl = 'https://steamcommunity.com/openid/login?' + new URLSearchParams({
        'openid.ns':         'http://specs.openid.net/auth/2.0',
        'openid.mode':       'checkid_setup',
        'openid.return_to':  `${SALES_URL}/auth/steam/callback`,
        'openid.realm':      SALES_URL + '/',
        'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    }).toString();
    redirect(res, steamUrl);
}

/* ── Route: GET /auth/steam/callback — verify + set cookie ───────────── */
async function handleSteamCallback(req, res) {
    const u = new URL(req.url, SALES_URL);
    const q = Object.fromEntries(u.searchParams.entries());
    if (q['openid.mode'] !== 'id_res') return redirect(res, '/?steam=error');

    /* Re-sign every openid.* param back to Steam to confirm the assertion. */
    const verifyParams = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
        if (k.startsWith('openid.')) verifyParams.set(k, v);
    }
    verifyParams.set('openid.mode', 'check_authentication');

    let steamId = null;
    try {
        const body = await steamVerifyPost(verifyParams);
        if (!body.includes('is_valid:true')) return redirect(res, '/?steam=error');
        const m = (q['openid.claimed_id'] || '').match(/\/openid\/id\/(\d+)$/);
        steamId = m ? m[1] : null;
    } catch (e) {
        console.error('[steam] verify failed:', e.message);
        return redirect(res, '/?steam=error');
    }
    if (!steamId) return redirect(res, '/?steam=error');

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.writeHead(302, {
        'Set-Cookie': `${STEAM_COOKIE}=${signSteam(steamId)}; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=3600`,
        Location: '/?steam=ok',
    });
    res.end();
}

/* ── Route: POST /api/checkout ───────────────────────────────────────── */
async function handleCheckout(req, res) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }

    if (!STRIPE_SECRET || !PRICE_ID) return json(res, 503, { error: 'Stripe not configured' });

    /* Require a verified Steam identity before taking payment. */
    const steamId = verifySteam(req);
    if (!steamId) return json(res, 401, { error: 'Sign in with Steam first' });

    try {
        const session = await stripePost('checkout/sessions', {
            'payment_method_types[0]': 'card',
            'line_items[0][price]': PRICE_ID,
            'line_items[0][quantity]': '1',
            mode: 'subscription',
            success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: CANCEL_URL,
            'customer_email': body.email || '',
            'metadata[customer_name]': body.name || '',
            'metadata[steam_id]': steamId,
            'subscription_data[metadata][steam_id]': steamId,
        });

        /* Create pending order immediately so we can track it */
        DB.createOrder({
            stripeSession: session.id,
            customerEmail: body.email || '',
            customerName: body.name || '',
            plan: 'standard',
            steamId,
        });

        json(res, 200, { url: session.url });
    } catch (e) {
        console.error('[checkout]', e.message);
        json(res, 500, { error: e.message });
    }
}

/* ── Route: POST /webhook ────────────────────────────────────────────── */
async function handleWebhook(req, res) {
    const rawBody = await readBody(req);
    const sig = req.headers['stripe-signature'];

    /* Verify Stripe signature */
    if (STRIPE_WHSEC && sig) {
        try {
            verifyStripeSignature(rawBody, sig, STRIPE_WHSEC);
        } catch (e) {
            console.warn('[webhook] Bad signature:', e.message);
            return json(res, 400, { error: 'invalid signature' });
        }
    }

    let event;
    try { event = JSON.parse(rawBody); } catch { return json(res, 400, { error: 'bad json' }); }

    res.writeHead(200); res.end('ok'); /* Respond fast, process async */

    setImmediate(async () => {
        try {
            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                const order = DB.getOrderBySession(session.id);
                if (!order) {
                    console.warn('[webhook] Unknown session:', session.id);
                    return;
                }
                /* Managed pilot: payment is confirmed, but an admin approves the
                   provision. Record payment + subscription and flag for review. */
                let sub = null;
                if (session.subscription) {
                    try { sub = await stripeGet(`subscriptions/${session.subscription}`); }
                    catch (e) { console.warn('[webhook] failed to fetch subscription:', e.message); }
                }
                DB.updateOrder(order.id, {
                    status: 'awaiting_approval',
                    stripe_payment: session.payment_intent || session.subscription || null,
                    stripe_customer: session.customer || order.stripe_customer || null,
                    stripe_subscription: session.subscription || null,
                    subscription_status: sub?.status || order.subscription_status || 'active',
                    subscription_current_period_end: stripeTs(sub?.current_period_end) || order.subscription_current_period_end || null,
                    subscription_cancel_at_period_end: sub?.cancel_at_period_end ? 1 : 0,
                    subscription_canceled_at: stripeTs(sub?.canceled_at) || null,
                    steam_id: session.metadata?.steam_id || order.steam_id || null,
                });
                console.log(`[webhook] Order ${order.id} paid → awaiting_approval`);
                try {
                    await Mailer.sendAdminNewOrderEmail({
                        orderId: order.id,
                        customerEmail: order.customer_email,
                        steamId: session.metadata?.steam_id || order.steam_id,
                    });
                } catch (e) { console.error('[webhook] admin email failed:', e.message); }
            } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
                await handleSubscriptionStateChange(event.data.object);
            } else if (event.type === 'customer.subscription.deleted') {
                await handleSubscriptionCanceled(event.data.object);
            } else if (event.type === 'invoice.payment_failed') {
                await handlePaymentFailed(event.data.object);
            } else if (event.type === 'invoice.paid') {
                await handleInvoicePaid(event.data.object);
            }
        } catch (e) {
            console.error('[webhook] handler failed:', e.message);
        }
    });
}

/* ── Subscription lifecycle → bot access ─────────────────────────────── */
function findOrderForSubscription(sub) {
    if (sub?.id) {
        const bySub = DB.getOrderBySubscription(sub.id);
        if (bySub) return bySub;
    }
    if (sub?.customer) {
        const byCustomer = DB.getOrderByStripeCustomer(sub.customer);
        if (byCustomer) return byCustomer;
    }
    return null;
}

function buildAccountPayload(order, history = []) {
    if (!order) return null;
    return {
        orderId: order.id,
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        steamId: order.steam_id,
        status: order.status,
        setupUrl: order.setup_url,
        pelicanServerId: order.pelican_server_id,
        subscription: {
            id: order.stripe_subscription,
            customerId: order.stripe_customer,
            status: order.subscription_status,
            currentPeriodEnd: order.subscription_current_period_end,
            cancelAtPeriodEnd: !!order.subscription_cancel_at_period_end,
            canceledAt: order.subscription_canceled_at,
        },
        history: history.map(o => ({
            orderId: o.id,
            status: o.status,
            createdAt: o.created_at,
            plan: o.plan,
            subscriptionStatus: o.subscription_status,
        })),
    };
}

async function handleAccount(req, res) {
    const steamId = verifySteam(req);
    if (!steamId) return json(res, 401, { error: 'Sign in with Steam first' });
    const latest = DB.getLatestOrderForSteam(steamId);
    if (!latest) return json(res, 404, { error: 'No subscription found for this Steam account' });
    const history = DB.getOrdersForUser({ steamId, limit: 10 });
    return json(res, 200, { account: buildAccountPayload(latest, history) });
}

async function handlePortal(req, res) {
    if (!STRIPE_SECRET) return json(res, 503, { error: 'Stripe not configured' });
    const steamId = verifySteam(req);
    if (!steamId) return json(res, 401, { error: 'Sign in with Steam first' });
    const latest = DB.getLatestOrderForSteam(steamId);
    if (!latest || !latest.stripe_customer) {
        return json(res, 404, { error: 'No Stripe customer found for this account' });
    }
    try {
        const session = await stripePost('billing_portal/sessions', {
            customer: latest.stripe_customer,
            return_url: BILLING_PORTAL_RETURN_URL,
        });
        return json(res, 200, { url: session.url });
    } catch (e) {
        console.error('[portal]', e.message);
        return json(res, 500, { error: 'Unable to open billing portal right now' });
    }
}

async function handleSubscriptionStateChange(sub) {
    const order = findOrderForSubscription(sub);
    if (!order) {
        console.warn('[webhook] subscription update: no order found', sub?.id || sub?.customer || 'unknown');
        return;
    }
    if (order.status === 'deleted') return;

    const nextStatus = normalizeSubStatus(sub.status, order.status === 'awaiting_approval' ? 'awaiting_approval' : 'active');
    DB.updateOrder(order.id, {
        stripe_customer: sub.customer || order.stripe_customer || null,
        stripe_subscription: sub.id || order.stripe_subscription || null,
        subscription_status: sub.status || order.subscription_status || null,
        subscription_current_period_end: stripeTs(sub.current_period_end),
        subscription_cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
        subscription_canceled_at: stripeTs(sub.canceled_at),
        status: nextStatus,
    });
    console.log(`[webhook] Subscription ${sub.id} -> ${sub.status} (order ${order.id} -> ${nextStatus})`);
}

async function handleSubscriptionCanceled(sub) {
    const order = findOrderForSubscription(sub);
    if (!order) { console.warn('[webhook] cancel: no order for subscription', sub.id); return; }
    if (order.status === 'deleted') return;
    if (order.pelican_server_id) {
        try { await Pelican.suspendServer(order.pelican_server_id); }
        catch (e) { console.error('[webhook] suspend failed:', e.message); }
    }
    DB.updateOrder(order.id, {
        status: 'suspended',
        stripe_customer: sub.customer || order.stripe_customer || null,
        stripe_subscription: sub.id || order.stripe_subscription || null,
        subscription_status: sub.status || 'canceled',
        subscription_current_period_end: stripeTs(sub.current_period_end),
        subscription_cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
        subscription_canceled_at: stripeTs(sub.canceled_at) || new Date().toISOString(),
    });
    console.log(`[webhook] Order ${order.id} suspended (subscription canceled)`);
    try { await Mailer.sendSuspendedEmail({ to: order.customer_email, name: order.customer_name, orderId: order.id }); }
    catch (e) { console.error('[webhook] suspended email failed:', e.message); }
}

async function handlePaymentFailed(invoice) {
    const order = invoice.subscription
        ? DB.getOrderBySubscription(invoice.subscription)
        : (invoice.customer ? DB.getOrderByStripeCustomer(invoice.customer) : null);
    if (!order) return;
    DB.updateOrder(order.id, {
        status: 'past_due',
        subscription_status: 'past_due',
    });
    console.log(`[webhook] Order ${order.id} past_due (payment failed)`);
}

async function handleInvoicePaid(invoice) {
    const order = invoice.subscription
        ? DB.getOrderBySubscription(invoice.subscription)
        : (invoice.customer ? DB.getOrderByStripeCustomer(invoice.customer) : null);
    if (!order) return;
    /* Only act when the bot was paused; first/renewal invoices on an already
       active (or awaiting-approval) order need nothing. */
    if (order.status !== 'suspended' && order.status !== 'past_due') return;
    if (order.pelican_server_id) {
        try { await Pelican.unsuspendServer(order.pelican_server_id); }
        catch (e) { console.error('[webhook] unsuspend failed:', e.message); }
        DB.updateOrder(order.id, {
            status: 'active',
            subscription_status: 'active',
            subscription_cancel_at_period_end: 0,
            subscription_canceled_at: null,
        });
        console.log(`[webhook] Order ${order.id} resumed (invoice paid)`);
    }
}

/* ── Stripe signature verification (manual, no SDK) ──────────────────── */
function verifyStripeSignature(rawBody, header, secret) {
    const parts = {};
    header.split(',').forEach(p => {
        const [k, v] = p.split('=');
        if (!parts[k]) parts[k] = [];
        parts[k].push(v);
    });
    const ts = parts['t']?.[0];
    const sigs = parts['v1'] || [];
    if (!ts) throw new Error('No timestamp in Stripe-Signature');

    const payload = `${ts}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const match = sigs.some(s => crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex')));
    if (!match) throw new Error('Signature mismatch');

    /* Reject webhooks older than 5 minutes */
    if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) throw new Error('Webhook too old');
}

/* ── Admin API ───────────────────────────────────────────────────────── */
async function handleAdmin(req, res, requestUrl) {
    const pathname = requestUrl.pathname;
    const query = requestUrl.searchParams;
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const cookieFlags = `HttpOnly; SameSite=Strict${secure}; Path=/; Max-Age=86400`;

    /* POST /admin/login — set admin session cookie (exempt from auth guard) */
    if (req.method === 'POST' && pathname === '/admin/login') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
        if (String(body.token || '').trim() !== ADMIN_TOKEN) return json(res, 401, { error: 'wrong token' });
        res.writeHead(200, {
            'Set-Cookie': `admin_session=${ADMIN_TOKEN}; ${cookieFlags}`,
            'Content-Type': 'application/json',
        });
        return res.end(JSON.stringify({ ok: true }));
    }

    /* POST /admin/logout — clear admin session cookie */
    if (req.method === 'POST' && pathname === '/admin/logout') {
        res.writeHead(200, {
            'Set-Cookie': `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
            'Content-Type': 'application/json',
        });
        return res.end(JSON.stringify({ ok: true }));
    }

    /* All other /admin/* routes require auth */
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });

    /* GET /admin/stats */
    if (req.method === 'GET' && pathname === '/admin/stats') {
        const limit = parseInt(query.get('limit') || '200', 10);
        const status = query.get('status') || '';
        const search = query.get('search') || '';
        const portStats = DB.portStats();
        const orders = DB.listOrders({ limit, status, search });
        const orderCounts = DB.orderCounts();
        return json(res, 200, {
            tokens_available: DB.tokenPoolCount(),
            ports: portStats,
            order_counts: orderCounts,
            orders,
            test_orders_enabled: process.env.ALLOW_TEST_ORDERS === 'true',
        });
    }

    if (req.method === 'GET' && pathname === '/admin/users') {
        const limit = parseInt(query.get('limit') || '200', 10);
        const search = query.get('search') || '';
        return json(res, 200, {
            users: DB.listUsers({ limit, search }),
        });
    }

    if (req.method === 'GET' && pathname === '/admin/user-orders') {
        const steamId = query.get('steam_id');
        const email = query.get('email');
        if (!steamId && !email) return json(res, 400, { error: 'steam_id or email is required' });
        return json(res, 200, {
            orders: DB.getOrdersForUser({ steamId, email, limit: parseInt(query.get('limit') || '50', 10) }),
        });
    }

    /* POST /admin/test-order — fabricate a dummy awaiting_approval order so the
       Provision/Suspend/Restart/Delete lifecycle can be tested without Stripe.
       Off unless ALLOW_TEST_ORDERS=true — keep it disabled in real production. */
    if (req.method === 'POST' && pathname === '/admin/test-order') {
        if (process.env.ALLOW_TEST_ORDERS !== 'true') {
            return json(res, 403, { error: 'Test orders disabled — set ALLOW_TEST_ORDERS=true' });
        }
        const r = DB.createOrder({
            stripeSession: `test_${Date.now()}`,
            customerEmail: 'test@example.com',
            customerName: 'Test Customer',
            plan: 'standard',
            steamId: '76561198000000000',
        });
        DB.updateOrder(r.lastInsertRowid, { status: 'awaiting_approval' });
        return json(res, 200, { ok: true, orderId: r.lastInsertRowid });
    }

    /* POST /admin/tokens — add a bot token */
    if (req.method === 'POST' && pathname === '/admin/tokens') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
        if (!body.client_id || !body.bot_token) return json(res, 400, { error: 'client_id and bot_token required' });
        try {
            DB.addToken(body.client_id, body.bot_token);
            return json(res, 200, { ok: true, pool_size: DB.tokenPoolCount() });
        } catch (e) {
            return json(res, 409, { error: e.message });
        }
    }

    /* POST /admin/provision/:orderId — approve/provision (or re-provision) */
    if (req.method === 'POST' && pathname.startsWith('/admin/provision/')) {
        const orderId = parseInt(pathname.split('/').pop(), 10);
        try {
            await provisionOrder(orderId);
            return json(res, 200, { ok: true });
        } catch (e) {
            try { DB.updateOrder(orderId, { status: 'failed', error_msg: e.message }); } catch {}
            return json(res, 500, { error: e.message });
        }
    }

    /* POST /admin/{suspend|resume|restart|delete}/:orderId — lifecycle controls */
    const action = pathname.match(/^\/admin\/(suspend|resume|restart|delete)\/(\d+)$/);
    if (req.method === 'POST' && action) {
        const [, verb, idStr] = action;
        const orderId = parseInt(idStr, 10);
        const order = DB.getOrder(orderId);
        if (!order) return json(res, 404, { error: 'order not found' });
        try {
            if (verb === 'suspend') {
                if (order.pelican_server_id) await Pelican.suspendServer(order.pelican_server_id);
                DB.updateOrder(orderId, { status: 'suspended' });
            } else if (verb === 'resume') {
                if (order.pelican_server_id) await Pelican.unsuspendServer(order.pelican_server_id);
                DB.updateOrder(orderId, { status: 'active' });
            } else if (verb === 'restart') {
                if (!order.pelican_identifier) return json(res, 400, { error: 'no server identifier — provision first' });
                await Pelican.powerSignal(order.pelican_identifier, 'restart');
            } else if (verb === 'delete') {
                if (order.pelican_server_id) await Pelican.deleteServer(order.pelican_server_id);
                DB.releaseResourcesForOrder(orderId);
                DB.updateOrder(orderId, { status: 'deleted' });
            }
            return json(res, 200, { ok: true });
        } catch (e) {
            console.error(`[admin] ${verb} order ${orderId} failed:`, e.message);
            return json(res, 500, { error: e.message });
        }
    }

    json(res, 404, { error: 'not found' });
}

/* ── HTTP server ─────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://localhost`);
    const { pathname } = requestUrl;

    try {
        /* Static files */
        if (pathname === '/' || pathname === '/index.html') {
            return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html');
        }
        if (pathname === '/admin' || pathname === '/admin.html') {
            return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), 'text/html');
        }
        if (pathname === '/success') {
            return serveFile(res, path.join(PUBLIC_DIR, 'success.html'), 'text/html');
        }
        if (pathname === '/account' || pathname === '/account.html') {
            return serveFile(res, path.join(PUBLIC_DIR, 'account.html'), 'text/html');
        }
        if (pathname === '/clans' || pathname === '/clans.html') {
            return serveFile(res, path.join(PUBLIC_DIR, 'clans.html'), 'text/html');
        }
        /* ClanBot Platform app (Clan Manager SPA). /clan and /join/<code> load
           the app shell; /platform/* serves its built assets. */
        if (pathname === '/clan' || pathname.startsWith('/clan/') || pathname.startsWith('/join/') || pathname.startsWith('/apply/')) {
            return serveFile(res, path.join(PUBLIC_DIR, 'platform', 'index.html'), 'text/html');
        }
        if (pathname.startsWith('/platform/')) {
            const file = path.join(PUBLIC_DIR, 'platform', pathname.replace('/platform/', ''));
            const ext  = path.extname(file);
            const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html' }[ext] || 'application/octet-stream';
            return serveFile(res, file, mime);
        }
        if (pathname.startsWith('/public/')) {
            const file = path.join(PUBLIC_DIR, pathname.replace('/public/', ''));
            const ext  = path.extname(file);
            const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
            return serveFile(res, file, mime);
        }

        /* Steam OpenID (sign in before checkout) */
        if (pathname === '/auth/steam'          && req.method === 'GET') return handleSteamLogin(req, res);
        if (pathname === '/auth/steam/callback' && req.method === 'GET') return await handleSteamCallback(req, res);
        if (pathname === '/api/steam/me'        && req.method === 'GET') return json(res, 200, { steamId: verifySteam(req) });
        if (pathname === '/api/account'         && req.method === 'GET') return await handleAccount(req, res);
        if (pathname === '/api/portal'          && req.method === 'POST') return await handlePortal(req, res);

        /* Clanbot Accounts: cross-clan directory + SSO */
        if (pathname === '/api/roster'          && req.method === 'POST') return await handleRoster(req, res);
        if (pathname === '/api/clans'           && req.method === 'GET') return await handleClans(req, res);
        if (pathname === '/api/clans-lookup'    && req.method === 'POST') return await handleClansLookup(req, res);
        if (pathname === '/sso/launch'          && req.method === 'GET') return await handleSsoLaunch(req, res);
        if (pathname.startsWith('/api/myclan'))                          return await handleMyClanApi(req, res, requestUrl);

        /* API */
        if (pathname === '/api/checkout' && req.method === 'POST') return await handleCheckout(req, res);
        if (pathname === '/webhook'       && req.method === 'POST') return await handleWebhook(req, res);
        if (pathname.startsWith('/admin'))                          return await handleAdmin(req, res, requestUrl);

        res.writeHead(404); res.end('Not found');
    } catch (e) {
        console.error('[server error]', e);
        res.writeHead(500); res.end('Internal error');
    }
});

server.listen(PORT, () => {
    console.log(`[ClanBot Sales] Listening on port ${PORT}`);
    console.log(`[ClanBot Sales] Token pool: ${DB.tokenPoolCount()} available`);
});
