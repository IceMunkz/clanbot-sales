'use strict';
/**
 * ClanBot Platform: website-side Clan Manager storage tests — clans, roster
 * roles, invites, wipe plans/RSVPs, and the deployment bridge that
 * materializes platform clans from bot roster pushes.
 *
 * Runs with: npm test  (from clanbot-sales/)  — node --test
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function makeDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-clans-'));
    process.env.SALES_DATA_DIR = tmpDir;
    delete require.cache[require.resolve('../db')];
    return require('../db');
}

describe('platform clan manager', () => {
    let DB;
    beforeEach(() => { DB = makeDb(); });

    test('createClan makes the creator the owner', () => {
        const clanId = DB.createClan({ name: 'B2B', tag: 'B2B', ownerSteamId: 'S1', ownerName: 'John' });
        const clan = DB.getClan(clanId);
        assert.equal(clan.name, 'B2B');
        assert.equal(clan.owner_steam_id, 'S1');
        assert.equal(DB.getClanMemberRole(clanId, 'S1'), 'owner');
        const mine = DB.getPlatformClansForSteam('S1');
        assert.equal(mine.length, 1);
        assert.equal(mine[0].my_role, 'owner');
    });

    test('roster add / role / remove', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        DB.addClanMember(clanId, 'S2', 'Two');
        assert.equal(DB.getClanMemberRole(clanId, 'S2'), 'member');
        DB.setClanMemberRole(clanId, 'S2', 'leader');
        assert.equal(DB.getClanMemberRole(clanId, 'S2'), 'leader');
        DB.removeClanMember(clanId, 'S2');
        assert.equal(DB.getClanMemberRole(clanId, 'S2'), null);
        /* re-adding an existing member must not clobber their role */
        DB.addClanMember(clanId, 'S1', 'NewName');
        assert.equal(DB.getClanMemberRole(clanId, 'S1'), 'owner');
    });

    test('invites: redeem joins once, respects expiry and max uses', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        const code = DB.createClanInvite(clanId, 'S1', { maxUses: 1 });

        let r = DB.redeemClanInvite(code, 'S2', 'Two');
        assert.equal(r.ok, true);
        assert.equal(DB.getClanMemberRole(clanId, 'S2'), 'member');

        /* second redemption by a new member exceeds max_uses */
        r = DB.redeemClanInvite(code, 'S3', 'Three');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'used up');

        /* expired invite */
        const expired = DB.createClanInvite(clanId, 'S1', { expiresAt: Date.now() - 1000 });
        r = DB.redeemClanInvite(expired, 'S4', null);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'expired');

        /* rejoining is a friendly no-op that doesn't burn a use */
        const open = DB.createClanInvite(clanId, 'S1', {});
        const before = DB.getClanInvite(open).uses;
        r = DB.redeemClanInvite(open, 'S2', null);
        assert.equal(r.ok, true);
        assert.equal(DB.getClanInvite(open).uses, before);
    });

    test('wipe plans + rsvps', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        const id = DB.createWipePlan(clanId, { title: 'Force wipe', wipeTs: Date.now() + 86400000, createdBy: 'S1' });
        assert.ok(id > 0);
        DB.setWipePlanRsvp(id, 'S1', 'yes', null);
        DB.setWipePlanRsvp(id, 'S2', 'maybe', 'might be late');
        DB.setWipePlanRsvp(id, 'S2', 'yes', null);   // upsert overwrites
        const rsvps = DB.getWipePlanRsvps(id);
        assert.equal(rsvps.length, 2);
        assert.ok(rsvps.every(r => r.response === 'yes'));
        DB.setWipePlanStatus(id, 'done');
        assert.equal(DB.getWipePlan(id).status, 'done');
    });

    test('bridge materializes a clan from a deployment roster push and keeps it in sync', () => {
        const members = [
            { steamId: 'H1', role: 'hoster' },
            { steamId: 'M1', role: 'member' },
        ];
        const clanId = DB.bridgeDeploymentClan('guild-9', 'Bravo', members);
        assert.ok(clanId);
        const clan = DB.getClanByDeployment('guild-9');
        assert.equal(clan.name, 'Bravo');
        assert.equal(clan.owner_steam_id, 'H1');
        assert.equal(DB.getClanMemberRole(clanId, 'H1'), 'owner');   // hoster → owner
        assert.equal(DB.getClanMemberRole(clanId, 'M1'), 'member');

        /* second push: member left, leader joined, name updated — full replace */
        DB.bridgeDeploymentClan('guild-9', 'Bravo Renamed', [
            { steamId: 'H1', role: 'hoster' },
            { steamId: 'L1', role: 'leader' },
        ]);
        assert.equal(DB.getClanByDeployment('guild-9').name, 'Bravo Renamed');
        assert.equal(DB.getClanMemberRole(clanId, 'L1'), 'leader');
        assert.equal(DB.getClanMemberRole(clanId, 'M1'), null);
        /* still the same platform clan record, not a duplicate */
        assert.equal(DB.getClanByDeployment('guild-9').clan_id, clanId);
    });

    test('bridge with no members is a no-op', () => {
        assert.equal(DB.bridgeDeploymentClan('guild-empty', 'X', []), null);
        assert.equal(DB.getClanByDeployment('guild-empty'), undefined);
    });
});
