/* Typed client for the platform's /api/myclan surface (Steam-cookie auth). */

export interface ClanSummary { clanId: string; name: string; tag: string | null; myRole: string }
export interface RosterMember {
  steam_id: string; name: string | null; role: string
  stage: string | null; rank: string | null
  has_bed: number; bed_given_at: string | null
  has_locker: number; locker_given_at: string | null
  added_at: string
  persona: string | null; avatar: string | null
}
export interface WipeRsvp { steam_id: string; response: string; note: string | null; updated_at: string }
export interface WipePlan {
  id: number; clan_id: string; title: string; wipe_ts: number | null
  server_name: string | null; notes: string | null; status: string; rsvps: WipeRsvp[]
}
export interface Announcement { id: number; text: string; by_steam_id: string | null; created_at: string }
export interface MemberNote { id: number; text: string; by_steam_id: string | null; by_name: string | null; created_at: string }
export interface Application {
  id: number; clan_id: string; steam_id: string; name: string | null; message: string | null
  status: string; created_at: string
  persona: string | null; avatar: string | null
  vacBans: number | null; gameBans: number | null; daysSinceLastBan: number | null
}
export interface ActiveMember {
  steamId: string; role: string; inClan: boolean
  persona: string | null; avatar: string | null
}
export interface ClanDetail {
  clanId: string; name: string; tag: string | null
  deploymentGuildId: string | null; myRole: string
  applicationsOpen: boolean; applyUrl: string
  roster: RosterMember[]; wipes: WipePlan[]
  activeRoster: ActiveMember[]; activeTotal: number
  profiles: Record<string, { persona: string | null; avatar: string | null }>
  announcements: Announcement[]
  pendingApplications: number
}
export interface MyClanResponse { steamId: string; clans: ClanSummary[]; clan: ClanDetail | null }

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body?.error || `HTTP ${res.status}`, res.status)
  return body as T
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

const post = (path: string, body: unknown) =>
  req<{ ok: boolean; [k: string]: unknown }>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  me: () => req<{ steamId: string | null }>('/api/steam/me'),
  myclan: (clanId?: string) =>
    req<MyClanResponse>(`/api/myclan${clanId ? `?clan=${encodeURIComponent(clanId)}` : ''}`),
  create: (name: string, tag: string) => post('/api/myclan/create', { name, tag }),
  addMember: (clanId: string, steamId: string, name: string) =>
    post('/api/myclan/member/add', { clanId, steamId, name }),
  importActive: (clanId: string) =>
    post('/api/myclan/import-active', { clanId }) as Promise<{ ok: boolean; added: number }>,
  removeMember: (clanId: string, steamId: string) =>
    post('/api/myclan/member/remove', { clanId, steamId }),
  setRole: (clanId: string, steamId: string, role: string) =>
    post('/api/myclan/member/role', { clanId, steamId, role }),
  setStage: (clanId: string, steamId: string, stage: string) =>
    post('/api/myclan/member/stage', { clanId, steamId, stage }),
  setRank: (clanId: string, steamId: string, rank: string) =>
    post('/api/myclan/member/rank', { clanId, steamId, rank }),
  setFlag: (clanId: string, steamId: string, field: 'bed' | 'locker', value: boolean) =>
    post('/api/myclan/member/flag', { clanId, steamId, field, value }),
  notes: (clanId: string, steamId: string) =>
    req<{ notes: MemberNote[] }>(`/api/myclan/member/notes?clan=${encodeURIComponent(clanId)}&steamId=${encodeURIComponent(steamId)}`),
  addNote: (clanId: string, steamId: string, text: string) =>
    post('/api/myclan/member/note', { clanId, steamId, text }),
  announce: (clanId: string, text: string) => post('/api/myclan/announce', { clanId, text }),
  applications: (clanId: string) =>
    req<{ applications: Application[]; vettingEnabled: boolean }>(`/api/myclan/applications?clan=${encodeURIComponent(clanId)}`),
  decideApplication: (id: number, approve: boolean) =>
    post('/api/myclan/applications/decide', { id, approve }),
  setApplicationsOpen: (clanId: string, open: boolean) =>
    post('/api/myclan/applications/open', { clanId, open }),
  applyInfo: (clanId: string) =>
    req<{ clanId: string; name: string; tag: string | null; open: boolean; alreadyMember: boolean }>(`/api/myclan/applyinfo?clan=${encodeURIComponent(clanId)}`),
  apply: (clanId: string, message: string) => post('/api/myclan/apply', { clanId, message }),
  invite: (clanId: string) => post('/api/myclan/invite', { clanId }) as Promise<{ ok: boolean; code: string; url: string }>,
  join: (code: string) => post('/api/myclan/join', { code }),
  createWipe: (clanId: string, w: { title: string; wipeTs: number | null; serverName: string; notes: string }) =>
    post('/api/myclan/wipes', { clanId, ...w }),
  rsvp: (planId: number, response: string, note?: string) => post('/api/myclan/wipes/rsvp', { planId, response, note }),
  wipeStatus: (planId: number, status: string) => post('/api/myclan/wipes/status', { planId, status }),
}

/* Bot Clan Manager vocabulary — mirrored so the platform matches. */
export const STAGES = ['applicant', 'trial', 'member', 'departed'] as const
export const RANKS: { key: string; label: string; color: string }[] = [
  { key: 'leader',  label: 'Leader',  color: '#f59e0b' },
  { key: 'officer', label: 'Officer', color: '#60a5fa' },
  { key: 'member',  label: 'Member',  color: '#4ade80' },
  { key: 'recruit', label: 'Recruit', color: '#94a3b8' },
]
