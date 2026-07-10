/* Typed client for the platform's /api/myclan surface (Steam-cookie auth). */

export interface ClanSummary { clanId: string; name: string; tag: string | null; myRole: string }
export interface RosterMember { steam_id: string; name: string | null; role: string; added_at: string }
export interface WipeRsvp { steam_id: string; response: string; note: string | null; updated_at: string }
export interface WipePlan {
  id: number; clan_id: string; title: string; wipe_ts: number | null
  server_name: string | null; notes: string | null; status: string; rsvps: WipeRsvp[]
}
export interface ClanDetail {
  clanId: string; name: string; tag: string | null
  deploymentGuildId: string | null; myRole: string
  roster: RosterMember[]; wipes: WipePlan[]
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
  removeMember: (clanId: string, steamId: string) =>
    post('/api/myclan/member/remove', { clanId, steamId }),
  setRole: (clanId: string, steamId: string, role: string) =>
    post('/api/myclan/member/role', { clanId, steamId, role }),
  invite: (clanId: string) => post('/api/myclan/invite', { clanId }) as Promise<{ ok: boolean; code: string; url: string }>,
  join: (code: string) => post('/api/myclan/join', { code }),
  createWipe: (clanId: string, w: { title: string; wipeTs: number | null; serverName: string; notes: string }) =>
    post('/api/myclan/wipes', { clanId, ...w }),
  rsvp: (planId: number, response: string) => post('/api/myclan/wipes/rsvp', { planId, response }),
  wipeStatus: (planId: number, status: string) => post('/api/myclan/wipes/status', { planId, status }),
}
