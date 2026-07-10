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

    test('member profile fields: stage, rank, bed/locker flags', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        DB.addClanMember(clanId, 'S2', 'Two');
        DB.setClanMemberStage(clanId, 'S2', 'trial');
        DB.setClanMemberRank(clanId, 'S2', 'recruit');
        DB.setClanMemberFlag(clanId, 'S2', 'bed', true);
        DB.setClanMemberFlag(clanId, 'S2', 'locker', true);
        let m = DB.getClanRoster(clanId).find(x => x.steam_id === 'S2');
        assert.equal(m.stage, 'trial');
        assert.equal(m.rank, 'recruit');
        assert.equal(m.has_bed, 1);
        assert.ok(m.bed_given_at);
        assert.equal(m.has_locker, 1);
        DB.setClanMemberFlag(clanId, 'S2', 'bed', false);
        m = DB.getClanRoster(clanId).find(x => x.steam_id === 'S2');
        assert.equal(m.has_bed, 0);
        assert.equal(m.bed_given_at, null);
    });

    test('bridge preserves platform profile fields across roster pushes', () => {
        const clanId = DB.bridgeDeploymentClan('guild-p', 'P', [
            { steamId: 'H1', role: 'hoster' }, { steamId: 'M1', role: 'member' },
        ]);
        DB.setClanMemberStage(clanId, 'M1', 'trial');
        DB.setClanMemberFlag(clanId, 'M1', 'bed', true);
        /* next 10-min push must NOT wipe stage/bed */
        DB.bridgeDeploymentClan('guild-p', 'P', [
            { steamId: 'H1', role: 'hoster' }, { steamId: 'M1', role: 'member' },
        ]);
        const m = DB.getClanRoster(clanId).find(x => x.steam_id === 'M1');
        assert.equal(m.stage, 'trial');
        assert.equal(m.has_bed, 1);
    });

    test('member notes timeline', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        DB.addClanMember(clanId, 'S2', 'Two');
        DB.addClanMemberNote(clanId, 'S2', 'good builder', 'S1', 'Owner');
        DB.addClanMemberNote(clanId, 'S2', 'was late to wipe', 'S1', 'Owner');
        const notes = DB.listClanMemberNotes(clanId, 'S2');
        assert.equal(notes.length, 2);
        assert.equal(notes[0].text, 'was late to wipe'); // newest first
        assert.equal(notes[0].by_name, 'Owner');
    });

    test('announcements: post + latest-first listing', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        DB.postClanAnnouncement(clanId, 'first', 'S1');
        DB.postClanAnnouncement(clanId, 'second', 'S1');
        const list = DB.listClanAnnouncements(clanId, 5);
        assert.equal(list.length, 2);
        assert.equal(list[0].text, 'second');
    });

    test('applications: apply once, approve adds trial member, deny does not', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });

        const id1 = DB.createClanApplication(clanId, 'A1', 'App One', 'hi');
        const dup = DB.createClanApplication(clanId, 'A1', 'App One', 'hi again');
        assert.equal(id1, dup); // one live application per applicant

        const id2 = DB.createClanApplication(clanId, 'A2', 'App Two', null);
        assert.equal(DB.listClanApplications(clanId, 'pending').length, 2);

        DB.decideClanApplication(id1, true, 'S1');
        assert.equal(DB.getClanMemberRole(clanId, 'A1'), 'member');
        assert.equal(DB.getClanRoster(clanId).find(m => m.steam_id === 'A1').stage, 'trial');

        DB.decideClanApplication(id2, false, 'S1');
        assert.equal(DB.getClanMemberRole(clanId, 'A2'), null);
        assert.equal(DB.listClanApplications(clanId, 'pending').length, 0);
        /* double-decide is a no-op */
        assert.equal(DB.decideClanApplication(id2, true, 'S1'), null);
    });

    test('applications open/closed toggle persists', () => {
        const clanId = DB.createClan({ name: 'C', ownerSteamId: 'S1' });
        assert.equal(DB.getClan(clanId).applications_open, 1);
        DB.setClanApplicationsOpen(clanId, false);
        assert.equal(DB.getClan(clanId).applications_open, 0);
    });

    test('steam profile cache upsert + batch get', () => {
        DB.upsertSteamProfile({ steamId: '76561198000000001', persona: 'Player1', avatar: 'http://a/1.jpg', vacBans: 0, gameBans: 0, daysSinceLastBan: 0 });
        DB.upsertSteamProfile({ steamId: '76561198000000001', persona: null, avatar: null, vacBans: 2, gameBans: null, daysSinceLastBan: 10 });
        const rows = DB.getSteamProfiles(['76561198000000001', '76561198000000002']);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].persona, 'Player1'); // COALESCE keeps old persona
        assert.equal(rows[0].vac_bans, 2);        // new ban data applied
    });
});
