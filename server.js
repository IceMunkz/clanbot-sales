'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DB      = require('./db');
const Pelican = require('./pelican');
const Mailer  = require('./mailer');

const PORT          = parseInt(process.env.SALES_PORT || '4000', 10);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WHSEC  = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID      = process.env.STRIPE_PRICE_ID;        // monthly recurring price
const SUCCESS_URL   = process.env.SUCCESS_URL || `http://localhost:${PORT}/success`;
const CANCEL_URL    = process.env.CANCEL_URL  || `http://localhost:${PORT}/`;
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const PUBLIC_DIR    = path.join(__dirname, 'public');

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

/* ── Provisioning ────────────────────────────────────────────────────── */
async function provisionOrder(orderId) {
    const order = DB.getOrder(orderId);
    if (!order) throw new Error('Order not found');

    DB.updateOrder(orderId, { status: 'provisioning' });

    const portRow = DB.getAvailablePort();
    if (!portRow) throw new Error('No ports available (3006-3050 exhausted)');

    const tokenRow = DB.getAvailableToken();
    if (!tokenRow) throw new Error('Token pool empty — add more bot tokens in admin panel');

    /* Reserve port + token */
    DB.assignPort(portRow.port, orderId);
    DB.assignToken(tokenRow.id, orderId);
    DB.updateOrder(orderId, {
        pelican_port: portRow.port,
        discord_token_id: tokenRow.id,
    });

    const { serverId, setupUrl } = await Pelican.createServer({
        orderId,
        customerEmail: order.customer_email,
        port: portRow.port,
        discordToken: tokenRow.bot_token,
        discordClientId: tokenRow.client_id,
    });

    DB.updateOrder(orderId, {
        status: 'active',
        pelican_server_id: serverId,
        setup_url: setupUrl,
        provisioned_at: new Date().toISOString(),
    });

    await Mailer.sendProvisionedEmail({
        to: order.customer_email,
        name: order.customer_name,
        setupUrl,
        orderId,
    });

    console.log(`[provision] Order ${orderId} → port ${portRow.port}, server ${serverId}`);
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
    const cookie = parseCookies(req)['admin_token'] || '';
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

/* ── Route: POST /api/checkout ───────────────────────────────────────── */
async function handleCheckout(req, res) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }

    if (!STRIPE_SECRET || !PRICE_ID) return json(res, 503, { error: 'Stripe not configured' });

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
        });

        /* Create pending order immediately so we can track it */
        DB.createOrder({
            stripeSession: session.id,
            customerEmail: body.email || '',
            customerName: body.name || '',
            plan: 'standard',
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
                DB.updateOrder(order.id, { stripe_payment: session.payment_intent || session.subscription });
                await provisionOrder(order.id);
            } else if (event.type === 'customer.subscription.deleted') {
                /* Optional: handle cancellations */
                console.log('[webhook] Subscription cancelled:', event.data.object.id);
            }
        } catch (e) {
            console.error('[webhook] Provision failed:', e.message);
            /* Try to update order with error */
            try {
                const session = event.data?.object;
                if (session?.id) {
                    const order = DB.getOrderBySession(session.id);
                    if (order) {
                        DB.updateOrder(order.id, { status: 'failed', error_msg: e.message });
                        await Mailer.sendFailureEmail({
                            to: order.customer_email,
                            name: order.customer_name,
                            orderId: order.id,
                            error: e.message,
                        });
                    }
                }
            } catch {}
        }
    });
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
async function handleAdmin(req, res, pathname) {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });

    /* GET /admin/stats */
    if (req.method === 'GET' && pathname === '/admin/stats') {
        const portStats = DB.portStats();
        return json(res, 200, {
            tokens_available: DB.tokenPoolCount(),
            ports: portStats,
            orders: DB.listOrders(200),
        });
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

    /* POST /admin/provision/:orderId — manual re-provision */
    if (req.method === 'POST' && pathname.startsWith('/admin/provision/')) {
        const orderId = parseInt(pathname.split('/').pop(), 10);
        try {
            await provisionOrder(orderId);
            return json(res, 200, { ok: true });
        } catch (e) {
            return json(res, 500, { error: e.message });
        }
    }

    /* POST /admin/login — set admin cookie */
    if (req.method === 'POST' && pathname === '/admin/login') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
        if (body.token !== ADMIN_TOKEN) return json(res, 401, { error: 'wrong token' });
        res.writeHead(200, {
            'Set-Cookie': `admin_token=${ADMIN_TOKEN}; HttpOnly; Path=/; Max-Age=86400`,
            'Content-Type': 'application/json',
        });
        return res.end(JSON.stringify({ ok: true }));
    }

    json(res, 404, { error: 'not found' });
}

/* ── HTTP server ─────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://localhost`);

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
        if (pathname.startsWith('/public/')) {
            const file = path.join(PUBLIC_DIR, pathname.replace('/public/', ''));
            const ext  = path.extname(file);
            const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
            return serveFile(res, file, mime);
        }

        /* API */
        if (pathname === '/api/checkout' && req.method === 'POST') return await handleCheckout(req, res);
        if (pathname === '/webhook'       && req.method === 'POST') return await handleWebhook(req, res);
        if (pathname.startsWith('/admin'))                          return await handleAdmin(req, res, pathname);

        res.writeHead(404); res.end('Not found');
    } catch (e) {
        console.error('[server error]', e);
        res.writeHead(500); res.end('Internal error');
    }
});

server.listen(PORT, () => {
    console.log(`[ClanBot Sales] Listening on port ${PORT}`);
    console.log(`[ClanBot Sales] Admin token: ${ADMIN_TOKEN}`);
    console.log(`[ClanBot Sales] Token pool: ${DB.tokenPoolCount()} available`);
});
