'use strict';
/**
 * T4: Sales provisioning idempotency and race-safety tests
 * Tests that duplicate webhooks and concurrent calls do not double-provision.
 *
 * Runs with: node --test sales-server/test/idempotency.test.js
 * (from repo root)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/* ── Set up an in-memory DB using the same schema as db.js ──────────── */
let DB;
let db;

function makeDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-test-'));
    process.env.SALES_DATA_DIR = tmpDir;
    /* Re-require to get a fresh module with the test DB */
    Object.keys(require.cache).forEach(k => { if (k.includes('sales-server/db')) delete require.cache[k]; });
    return require('../db');
}

describe('sales provisioning idempotency', () => {
    before(() => {
        DB = makeDb();
        db = DB.db;
        /* Seed: add tokens to cover all test scenarios */
        for (let i = 1; i <= 10; i++) {
            DB.addToken(`client_test_${i}`, `bot_token_test_${i}`);
        }
    });

    after(() => {
        try { db.close(); } catch {}
    });

    test('T4-1: duplicate eventId returns alreadyDone=true, only 1 resource assigned', () => {
        const orderId = DB.createOrder({
            stripeSession: 'sess_dup_1',
            customerEmail: 'dup@test.com',
            customerName: 'Dup Test',
            plan: 'standard',
        }).lastInsertRowid;

        const eventId = 'evt_duplicate_test_001';

        /* First call: should succeed */
        const first = DB.reserveResourcesForOrder(orderId, eventId);
        assert.equal(first.alreadyDone, false, 'First call should not be alreadyDone');
        assert.ok(first.port, 'First call should return a port');
        assert.ok(first.token, 'First call should return a token');

        /* Second call with same eventId: idempotent */
        const second = DB.reserveResourcesForOrder(orderId, eventId);
        assert.equal(second.alreadyDone, true, 'Second call with same eventId should be alreadyDone');

        /* Verify only 1 record in processed_events */
        const rows = db.prepare('SELECT * FROM processed_events WHERE event_id = ?').all(eventId);
        assert.equal(rows.length, 1, 'Should have exactly 1 processed_events row');

        /* Verify port is still assigned once (not twice) */
        const assignedPorts = db.prepare("SELECT * FROM port_pool WHERE order_id = ? AND status = 'assigned'").all(orderId);
        assert.equal(assignedPorts.length, 1, 'Should have exactly 1 port assigned to this order');
    });

    test('T4-2: already-active order returns alreadyDone=true, 0 extra resources', () => {
        const orderId = DB.createOrder({
            stripeSession: 'sess_active_1',
            customerEmail: 'active@test.com',
            customerName: 'Active Test',
            plan: 'standard',
        }).lastInsertRowid;

        /* Mark order as already active */
        DB.updateOrder(orderId, { status: 'active' });

        const result = DB.reserveResourcesForOrder(orderId, 'evt_already_active_001');
        assert.equal(result.alreadyDone, true, 'Active order should skip provisioning');

        /* No port should have been assigned to this order */
        const assignedPorts = db.prepare("SELECT * FROM port_pool WHERE order_id = ?").all(orderId);
        assert.equal(assignedPorts.length, 0, 'No ports should be assigned to already-active order');
    });

    test('T4-3: concurrent Promise.all calls — exactly 1 succeeds, 1 is idempotent', async () => {
        const orderId = DB.createOrder({
            stripeSession: 'sess_concurrent_1',
            customerEmail: 'concurrent@test.com',
            customerName: 'Concurrent Test',
            plan: 'standard',
        }).lastInsertRowid;

        const eventId = 'evt_concurrent_race_001';

        /* Simulate concurrent calls with same eventId */
        const [r1, r2] = await Promise.all([
            Promise.resolve(DB.reserveResourcesForOrder(orderId, eventId)),
            Promise.resolve(DB.reserveResourcesForOrder(orderId, eventId)),
        ]);

        /* Exactly one should succeed and one should be idempotent */
        const successes = [r1, r2].filter(r => !r.alreadyDone);
        const idempotents = [r1, r2].filter(r => r.alreadyDone);
        assert.equal(successes.length, 1, 'Exactly 1 call should succeed');
        assert.equal(idempotents.length, 1, 'Exactly 1 call should be idempotent');

        /* Only 1 resource assigned */
        const ports = db.prepare("SELECT * FROM port_pool WHERE order_id = ? AND status = 'assigned'").all(orderId);
        assert.equal(ports.length, 1, 'Exactly 1 port should be assigned');
    });

    test('T4-4: different eventIds for different orders both succeed with distinct ports', () => {
        const orderId1 = DB.createOrder({
            stripeSession: 'sess_distinct_1',
            customerEmail: 'a@test.com',
            customerName: 'Order A',
            plan: 'standard',
        }).lastInsertRowid;

        const orderId2 = DB.createOrder({
            stripeSession: 'sess_distinct_2',
            customerEmail: 'b@test.com',
            customerName: 'Order B',
            plan: 'standard',
        }).lastInsertRowid;

        const r1 = DB.reserveResourcesForOrder(orderId1, 'evt_distinct_001');
        const r2 = DB.reserveResourcesForOrder(orderId2, 'evt_distinct_002');

        assert.equal(r1.alreadyDone, false);
        assert.equal(r2.alreadyDone, false);
        assert.notEqual(r1.port, r2.port, 'Different orders should get different ports');
    });

    test('T4-5: getProcessedEvent returns undefined for unknown, correct row for processed', () => {
        const unknown = DB.getProcessedEvent('evt_never_processed');
        assert.equal(unknown, undefined, 'Unknown event should return undefined');

        const orderId = DB.createOrder({
            stripeSession: 'sess_get_evt_1',
            customerEmail: 'get@test.com',
            customerName: 'Get Test',
            plan: 'standard',
        }).lastInsertRowid;
        const eventId = 'evt_get_processed_001';
        DB.reserveResourcesForOrder(orderId, eventId);

        const found = DB.getProcessedEvent(eventId);
        assert.ok(found, 'Processed event should be found');
        assert.equal(found.event_id, eventId);
        assert.equal(found.order_id, orderId);
    });
});
