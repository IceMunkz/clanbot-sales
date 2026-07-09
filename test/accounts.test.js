'use strict';
/**
 * Clanbot Accounts directory tests: deployments + memberships storage and the
 * cross-clan lookup that powers "My Clans" and SSO.
 *
 * Runs with: npm test  (from clanbot-sales/)  — node --test
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/* Fresh DB bound to a throwaway data dir for each test. */
function makeDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-accounts-'));
    process.env.SALES_DATA_DIR = tmpDir;
    delete require.cache[require.resolve('../db')];
    return require('../db');
}

describe('clanbot accounts directory', () => {
    let DB;
    beforeEach(() => { DB = makeDb(); });

    test('upsertDeployment creates then updates without clobbering the secret', () => {
        DB.upsertDeployment({ guildId: 'g1', clanName: 'Alpha', dashboardUrl: 'https://a.example' });
        DB.setDeploymentSecret('g1', 'sekret');

        let d = DB.getDeployment('g1');
        assert.equal(d.clan_name, 'Alpha');
        assert.equal(d.dashboard_url, 'https://a.example');
        assert.equal(d.shared_secret, 'sekret');

        /* A later roster push updates metadata but must never touch the secret. */
        DB.upsertDeployment({ guildId: 'g1', clanName: 'Alpha Renamed', dashboardUrl: 'https://a2.example' });
        d = DB.getDeployment('g1');
        assert.equal(d.clan_name, 'Alpha Renamed');
        assert.equal(d.dashboard_url, 'https://a2.example');
        assert.equal(d.shared_secret, 'sekret');
    });

    test('replaceRoster + getClansForSteam + isMemberOf', () => {
        DB.upsertDeployment({ guildId: 'g1', clanName: 'Alpha', dashboardUrl: 'https://a' });
        DB.upsertDeployment({ guildId: 'g2', clanName: 'Bravo', dashboardUrl: 'https://b' });
        DB.replaceRoster('g1', [{ steamId: 'S1', role: 'hoster' }, { steamId: 'S2', role: 'member' }]);
        DB.replaceRoster('g2', [{ steamId: 'S1', role: 'member' }]);

        const s1 = DB.getClansForSteam('S1');
        assert.equal(s1.length, 2);
        const g1 = s1.find(c => c.guild_id === 'g1');
        assert.equal(g1.role, 'hoster');
        assert.equal(g1.clan_name, 'Alpha');
        assert.equal(g1.dashboard_url, 'https://a');

        assert.ok(DB.isMemberOf('S1', 'g1'));
        assert.ok(DB.isMemberOf('S1', 'g2'));
        assert.ok(DB.isMemberOf('S2', 'g1'));
        assert.ok(!DB.isMemberOf('S2', 'g2'));
    });

    test('replaceRoster removes members who are no longer present', () => {
        DB.upsertDeployment({ guildId: 'g1', clanName: 'Alpha', dashboardUrl: 'https://a' });
        DB.replaceRoster('g1', [{ steamId: 'S1', role: 'member' }, { steamId: 'S2', role: 'member' }]);
        assert.ok(DB.isMemberOf('S2', 'g1'));

        DB.replaceRoster('g1', [{ steamId: 'S1', role: 'member' }]); // S2 left the clan
        assert.ok(DB.isMemberOf('S1', 'g1'));
        assert.ok(!DB.isMemberOf('S2', 'g1'));
        assert.equal(DB.getClansForSteam('S2').length, 0);
    });

    test('replaceRoster ignores entries without a steamId', () => {
        DB.upsertDeployment({ guildId: 'g1' });
        DB.replaceRoster('g1', [{ role: 'member' }, null, { steamId: 'S1', role: 'member' }]);
        assert.equal(DB.getClansForSteam('S1').length, 1);
    });

    test('memberships without a known deployment are not returned', () => {
        /* getClansForSteam INNER JOINs deployments, so an orphan membership
           (no deployment row) is invisible until the deployment reports in. */
        DB.replaceRoster('ghost', [{ steamId: 'S9', role: 'member' }]);
        assert.equal(DB.getClansForSteam('S9').length, 0);
    });
});
