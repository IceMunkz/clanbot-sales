'use strict';
/**
 * Access-management lifecycle tests: Steam-linked orders, subscription lookup
 * (used by cancel/suspend + resume webhooks), and resource release on delete.
 *
 * Runs with: node --test sales-server/test/lifecycle.test.js  (from repo root)
 * or:        npm test                                          (from sales-server/)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

let DB;
let db;

function makeDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-lifecycle-'));
    process.env.SALES_DATA_DIR = tmpDir;
    /* Re-require to get a fresh module bound to the test DB (normalise path
       separators so the cache key matches on Windows too). */
    Object.keys(require.cache).forEach(k => {
        if (k.replace(/\\/g, '/').includes('sales-server/db')) delete require.cache[k];
    });
    return require('../db');
}

describe('sales lifecycle + access management', () => {
    before(() => {
        DB = makeDb();
        db = DB.db;
        for (let i = 1; i <= 5; i++) DB.addToken(`client_${i}`, `bot_token_${i}`);
    });

    after(() => {
        try { db.close(); } catch {}
    });

    test('orders table has the new access-management columns', () => {
        const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
        for (const c of ['steam_id', 'stripe_subscription', 'pelican_identifier']) {
            assert.ok(cols.includes(c), `orders.${c} should exist`);
        }
    });

    test('createOrder persists the verified Steam ID', () => {
        const id = DB.createOrder({
            stripeSession: 'sess_steam_1',
            customerEmail: 's@test.com',
            customerName: 'S',
            plan: 'standard',
            steamId: '76561198000000001',
        }).lastInsertRowid;
        assert.equal(DB.getOrder(id).steam_id, '76561198000000001');
    });

    test('getOrderBySubscription matches stripe_subscription and the legacy stripe_payment', () => {
        const id = DB.createOrder({
            stripeSession: 'sess_sub_1', customerEmail: 'sub@test.com', customerName: 'Sub', plan: 'standard',
        }).lastInsertRowid;
        DB.updateOrder(id, { stripe_subscription: 'sub_ABC', stripe_payment: 'pi_XYZ' });
        assert.equal(DB.getOrderBySubscription('sub_ABC').id, id);

        /* Backward-compat: older orders stored the subscription id in stripe_payment. */
        const id2 = DB.createOrder({
            stripeSession: 'sess_sub_2', customerEmail: 'sub2@test.com', customerName: 'Sub2', plan: 'standard',
        }).lastInsertRowid;
        DB.updateOrder(id2, { stripe_payment: 'sub_LEGACY' });
        assert.equal(DB.getOrderBySubscription('sub_LEGACY').id, id2);

        assert.equal(DB.getOrderBySubscription('sub_DOES_NOT_EXIST'), undefined);
    });

    test('releaseResourcesForOrder frees the port and bot token back to the pools', () => {
        const id = DB.createOrder({
            stripeSession: 'sess_rel_1', customerEmail: 'rel@test.com', customerName: 'Rel', plan: 'standard',
        }).lastInsertRowid;

        const reserved = DB.reserveResourcesForOrder(id, 'evt_rel_1');
        assert.equal(reserved.alreadyDone, false);
        const port = reserved.port;
        const tokenId = reserved.token.id;

        assert.equal(db.prepare('SELECT status FROM port_pool WHERE port = ?').get(port).status, 'assigned');
        assert.equal(db.prepare('SELECT status FROM token_pool WHERE id = ?').get(tokenId).status, 'assigned');

        DB.releaseResourcesForOrder(id);

        const portRow = db.prepare('SELECT status, order_id FROM port_pool WHERE port = ?').get(port);
        assert.equal(portRow.status, 'available');
        assert.equal(portRow.order_id, null);
        const tokenRow = db.prepare('SELECT status, assigned_to FROM token_pool WHERE id = ?').get(tokenId);
        assert.equal(tokenRow.status, 'available');
        assert.equal(tokenRow.assigned_to, null);

        /* The freed port can be claimed by a new order. */
        const id2 = DB.createOrder({
            stripeSession: 'sess_rel_2', customerEmail: 'rel2@test.com', customerName: 'Rel2', plan: 'standard',
        }).lastInsertRowid;
        const reserved2 = DB.reserveResourcesForOrder(id2, 'evt_rel_2');
        assert.equal(reserved2.alreadyDone, false);
        assert.ok(reserved2.port);
    });
});
