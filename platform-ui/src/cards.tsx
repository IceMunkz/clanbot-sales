import { useEffect, useState } from 'react'
import { api, Application, ClanDetail, MemberNote, RANKS, RosterMember, STAGES, WipePlan } from './api'

/* Shared bits for the Clan Manager cards. */

export const CAN_LEAD = (role?: string | null) => role === 'owner' || role === 'leader'

export function initials(name: string | null, steamId: string) {
  const n = (name || '').trim()
  if (n) return n.slice(0, 2).toUpperCase()
  return steamId.slice(-2)
}

export function Avatar({ url, name, steamId, size = 32 }: { url: string | null; name: string | null; steamId: string; size?: number }) {
  if (url) return <img className="avatar" src={url} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />
  return <div className="avatar" style={{ width: size, height: size }}>{initials(name, steamId)}</div>
}

export function displayName(m: { persona?: string | null; name: string | null; steam_id: string }) {
  return m.persona || m.name || m.steam_id
}

function rankChip(rank: string | null) {
  if (!rank) return null
  const r = RANKS.find(x => x.key === rank)
  if (!r) return null
  return <span className="badge" style={{ background: `${r.color}33`, color: r.color }}>{r.label}</span>
}

function stageChip(stage: string | null) {
  if (!stage || stage === 'member') return null
  const colors: Record<string, string> = { applicant: '#f2c14e', trial: '#60a5fa', departed: '#f26464' }
  const c = colors[stage] || '#94a3b8'
  return <span className="badge" style={{ background: `${c}26`, color: c }}>{stage}</span>
}

/* ── Announcements ────────────────────────────────────────────────────── */

export function AnnouncementsCard({ clan, lead, onChanged }: { clan: ClanDetail; lead: boolean; onChanged: () => void }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const post = async () => {
    setErr('')
    try { await api.announce(clan.clanId, text.trim()); setText(''); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }
  if (!clan.announcements.length && !lead) return null
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>📣 Announcements</h2>
      {clan.announcements.length === 0 && <p style={{ fontSize: 14 }}>Nothing posted yet.</p>}
      {clan.announcements.map(a => (
        <div className="row" key={a.id}>
          <div className="row-main" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{a.text}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{new Date(a.created_at + 'Z').toLocaleString()}</div>
            </div>
          </div>
        </div>
      ))}
      {lead && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Post an announcement to the clan…" maxLength={2000} />
          <button className="btn-secondary" disabled={!text.trim()} onClick={post}>Post</button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  )
}

/* ── Roster ───────────────────────────────────────────────────────────── */

export function RosterCard({ clan, mySteamId, onChanged }: {
  clan: ClanDetail; mySteamId: string; onChanged: () => void
}) {
  const lead = CAN_LEAD(clan.myRole)
  const [addId, setAddId] = useState('')
  const [addName, setAddName] = useState('')
  const [open, setOpen] = useState<RosterMember | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const act = async (fn: () => Promise<unknown>, okMsg = '') => {
    setErr(''); setMsg('')
    try { await fn(); if (okMsg) setMsg(okMsg); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }

  const invite = () => act(async () => {
    const r = await api.invite(clan.clanId)
    await navigator.clipboard.writeText(r.url).catch(() => {})
    setMsg(`Invite link copied: ${r.url}`)
  })

  /* Keep the drawer's member fresh across reloads. */
  useEffect(() => {
    if (!open) return
    const fresh = clan.roster.find(m => m.steam_id === open.steam_id)
    if (fresh && fresh !== open) setOpen(fresh)
    if (!fresh) setOpen(null)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [clan.roster])

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>👥 Roster <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{clan.roster.length}</span></h2>
        {lead && <button className="btn-secondary btn-sm" onClick={invite}>🔗 Invite link</button>}
      </div>

      {clan.roster.map(m => (
        <div className="row row-click" key={m.steam_id} onClick={() => setOpen(m)}>
          <div className="row-main">
            <Avatar url={m.avatar} name={m.name} steamId={m.steam_id} />
            <div style={{ minWidth: 0 }}>
              <div className="name">
                {displayName(m)}{m.steam_id === mySteamId && <span className="muted"> (you)</span>}
                {' '}{m.has_bed ? <span title="Has bed">🛏️</span> : null}{m.has_locker ? <span title="Has locker">🔒</span> : null}
              </div>
              <div className="mono">{m.steam_id}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {stageChip(m.stage)}
            {rankChip(m.rank)}
            <span className={`badge role-${m.role}`}>{m.role}</span>
          </div>
        </div>
      ))}

      {lead && (
        <>
          <label>Add member by SteamID64</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={addId} onChange={e => setAddId(e.target.value)} placeholder="7656119…" />
            <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Name (optional)" />
            <button className="btn-secondary" disabled={!/^\d{17}$/.test(addId.trim())}
              onClick={() => act(async () => { await api.addMember(clan.clanId, addId.trim(), addName.trim()); setAddId(''); setAddName('') }, 'Member added')}>
              Add
            </button>
          </div>
        </>
      )}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="error">{err}</div>}

      {open && <MemberDrawer clan={clan} member={open} mySteamId={mySteamId} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </div>
  )
}

/* ── Member drawer — full profile: role, rank, stage, bed/locker, notes ── */

function MemberDrawer({ clan, member, mySteamId, onClose, onChanged }: {
  clan: ClanDetail; member: RosterMember; mySteamId: string; onClose: () => void; onChanged: () => void
}) {
  const lead = CAN_LEAD(clan.myRole)
  const owner = clan.myRole === 'owner'
  const [notes, setNotes] = useState<MemberNote[] | null>(null)
  const [noteText, setNoteText] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!lead) return
    api.notes(clan.clanId, member.steam_id).then(r => setNotes(r.notes)).catch(() => setNotes([]))
  }, [clan.clanId, member.steam_id, lead])

  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try { await fn(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }

  const addNote = () => act(async () => {
    await api.addNote(clan.clanId, member.steam_id, noteText.trim())
    setNoteText('')
    const r = await api.notes(clan.clanId, member.steam_id)
    setNotes(r.notes)
  })

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Avatar url={member.avatar} name={member.name} steamId={member.steam_id} size={48} />
            <div>
              <div className="name" style={{ fontSize: 17 }}>{displayName(member)}</div>
              <a className="mono" href={`https://steamcommunity.com/profiles/${member.steam_id}`} target="_blank" rel="noreferrer">
                {member.steam_id} ↗
              </a>
            </div>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="spacer" />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className={`badge role-${member.role}`}>{member.role}</span>
          {rankChip(member.rank)}
          {stageChip(member.stage)}
        </div>

        {lead && (
          <>
            <label>Rank</label>
            <select value={member.rank || ''} onChange={e => act(() => api.setRank(clan.clanId, member.steam_id, e.target.value))}>
              <option value="">— none —</option>
              {RANKS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>

            <label>Recruitment stage</label>
            <select value={member.stage || ''} onChange={e => act(() => api.setStage(clan.clanId, member.steam_id, e.target.value))}>
              <option value="">— none —</option>
              {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <label>Wipe checklist</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={`btn-sm ${member.has_bed ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => act(() => api.setFlag(clan.clanId, member.steam_id, 'bed', !member.has_bed))}>
                🛏️ Bed {member.has_bed ? 'given' : 'not given'}
              </button>
              <button className={`btn-sm ${member.has_locker ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => act(() => api.setFlag(clan.clanId, member.steam_id, 'locker', !member.has_locker))}>
                🔒 Locker {member.has_locker ? 'given' : 'not given'}
              </button>
            </div>

            {owner && member.role !== 'owner' && (
              <>
                <label>Platform role</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary btn-sm"
                    onClick={() => act(() => api.setRole(clan.clanId, member.steam_id, member.role === 'leader' ? 'member' : 'leader'))}>
                    {member.role === 'leader' ? 'Demote to member' : 'Promote to leader'}
                  </button>
                </div>
              </>
            )}

            {member.role !== 'owner' && member.steam_id !== mySteamId && (
              <>
                <div className="spacer" />
                <button className="btn-ghost btn-sm" style={{ color: 'var(--bad)' }}
                  onClick={() => { if (confirm(`Remove ${displayName(member)} from the clan?`)) act(() => api.removeMember(clan.clanId, member.steam_id)).then(onClose) }}>
                  Remove from clan
                </button>
              </>
            )}

            <label>Notes</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add a note (only leaders see these)…" maxLength={1000} />
              <button className="btn-secondary btn-sm" disabled={!noteText.trim()} onClick={addNote}>Add</button>
            </div>
            {notes === null ? <div className="muted" style={{ fontSize: 13 }}>Loading notes…</div>
              : notes.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No notes yet.</div>
              : notes.map(n => (
                <div key={n.id} style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', marginBottom: 6 }}>
                  <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{n.text}</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{n.by_name || n.by_steam_id || 'unknown'} · {new Date(n.created_at + 'Z').toLocaleString()}</div>
                </div>
              ))}
          </>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </div>
  )
}

/* ── Active clan — the live Rust+ team (read-only, transient) ─────────────
   Shows who is in the in-game team right now. It never changes the permanent
   clan roster; leaders explicitly promote real members (a merge raid can put
   hundreds of allies here — the count guards against a mass-import). */
export function ActiveClanCard({ clan, onChanged }: { clan: ClanDetail; onChanged: () => void }) {
  const lead = CAN_LEAD(clan.myRole)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const notInClan = clan.activeRoster.filter(m => !m.inClan)

  const add = async (m: ClanDetail['activeRoster'][number]) => {
    setErr('')
    try { await api.addMember(clan.clanId, m.steamId, m.persona || ''); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }
  const importAll = async () => {
    if (!confirm(`Add ${notInClan.length} active player${notInClan.length === 1 ? '' : 's'} to your permanent clan roster?\n\nOnly do this if these are all real clan members — during a merge raid this list includes allies.`)) return
    setErr('')
    try { const r = await api.importActive(clan.clanId); setMsg(`Added ${r.added} member${r.added === 1 ? '' : 's'} to the roster.`); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>🎮 Active clan <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>live in-game · {clan.activeTotal}</span></h2>
        {lead && notInClan.length > 0 && notInClan.length <= 60 && (
          <button className="btn-secondary btn-sm" onClick={importAll}>+ Add all {notInClan.length} to roster</button>
        )}
      </div>
      <p style={{ fontSize: 13, marginTop: 0 }}>Who's in your Rust+ team right now. This is a live view — it never changes your clan roster. Add the ones you want to keep.</p>

      {clan.activeRoster.length === 0 && <p className="muted" style={{ fontSize: 14 }}>Nobody in-game right now (or the bot hasn't reported yet).</p>}
      {clan.activeRoster.map(m => (
        <div className="row" key={m.steamId}>
          <div className="row-main">
            <Avatar url={m.avatar} name={null} steamId={m.steamId} />
            <div style={{ minWidth: 0 }}>
              <div className="name">{m.persona || m.steamId}</div>
              <div className="mono">{m.steamId}</div>
            </div>
          </div>
          <div>
            {m.inClan
              ? <span className="badge rsvp-yes">in roster</span>
              : lead
                ? <button className="btn-ghost btn-sm" onClick={() => add(m)}>+ Add</button>
                : <span className="muted" style={{ fontSize: 12 }}>guest</span>}
          </div>
        </div>
      ))}
      {clan.activeTotal > clan.activeRoster.length && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          …and {clan.activeTotal - clan.activeRoster.length} more in-game (merge in progress?)
        </div>
      )}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  )
}

/* ── Applications (recruitment pipeline + vetting) ────────────────────── */

export function ApplicationsCard({ clan, onChanged }: { clan: ClanDetail; onChanged: () => void }) {
  const [apps, setApps] = useState<Application[] | null>(null)
  const [vetting, setVetting] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = () => api.applications(clan.clanId)
    .then(r => { setApps(r.applications); setVetting(r.vettingEnabled) })
    .catch(e => setErr(e instanceof Error ? e.message : 'failed'))
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [clan.clanId, clan.pendingApplications])

  const copyApply = async () => {
    await navigator.clipboard.writeText(clan.applyUrl).catch(() => {})
    setMsg(`Apply link copied: ${clan.applyUrl}`)
  }
  const decide = async (id: number, approve: boolean) => {
    setErr('')
    try { await api.decideApplication(id, approve); await load(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }
  const toggleOpen = async () => {
    try { await api.setApplicationsOpen(clan.clanId, !clan.applicationsOpen); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>📥 Applications {apps && apps.length > 0 && <span className="badge rsvp-maybe">{apps.length}</span>}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary btn-sm" onClick={copyApply}>🔗 Apply link</button>
          <button className={`btn-sm ${clan.applicationsOpen ? 'btn-ghost' : 'btn-secondary'}`} onClick={toggleOpen}>
            {clan.applicationsOpen ? 'Open — click to close' : 'Closed — click to open'}
          </button>
        </div>
      </div>

      {apps === null && <p style={{ fontSize: 14 }}>Loading…</p>}
      {apps && apps.length === 0 && <p style={{ fontSize: 14 }}>No pending applications. Share the apply link to recruit.</p>}
      {apps && apps.map(a => (
        <div className="row" key={a.id}>
          <div className="row-main" style={{ alignItems: 'flex-start' }}>
            <Avatar url={a.avatar} name={a.name} steamId={a.steam_id} />
            <div style={{ minWidth: 0 }}>
              <div className="name">
                {a.persona || a.name || a.steam_id}
                {vetting && (a.vacBans || a.gameBans)
                  ? <span className="badge rsvp-no" style={{ marginLeft: 6 }} title={`VAC: ${a.vacBans ?? 0} · Game: ${a.gameBans ?? 0} · ${a.daysSinceLastBan ?? '?'}d since last`}>⚠ bans</span>
                  : vetting ? <span className="badge rsvp-yes" style={{ marginLeft: 6 }}>clean</span> : null}
              </div>
              <a className="mono" href={`https://steamcommunity.com/profiles/${a.steam_id}`} target="_blank" rel="noreferrer">{a.steam_id} ↗</a>
              {a.message && <div className="muted" style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.message}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-primary btn-sm" onClick={() => decide(a.id, true)}>Approve</button>
            <button className="btn-ghost btn-sm" onClick={() => decide(a.id, false)}>Deny</button>
          </div>
        </div>
      ))}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  )
}

/* ── Wipes ────────────────────────────────────────────────────────────── */

export function fmtCountdown(ts: number | null): string {
  if (!ts) return 'TBD'
  const ms = ts - Date.now()
  if (ms <= 0) return 'live now'
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

export function WipesCard({ clan, mySteamId, onChanged }: {
  clan: ClanDetail; mySteamId: string; onChanged: () => void
}) {
  const lead = CAN_LEAD(clan.myRole)
  const [showForm, setShowForm] = useState(false)
  const [err, setErr] = useState('')
  const scheduled = clan.wipes.filter(w => w.status === 'scheduled')
  const next = scheduled.length ? scheduled.reduce((a, b) =>
    (a.wipe_ts ?? Infinity) <= (b.wipe_ts ?? Infinity) ? a : b) : null

  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try { await fn(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }

  const nameOf = (steamId: string) => {
    const p = clan.profiles[steamId]
    if (p?.persona) return p.persona
    const m = clan.roster.find(x => x.steam_id === steamId)
    return m?.name || steamId.slice(-5)
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>🗓️ Wipes</h2>
        {lead && <button className="btn-secondary btn-sm" onClick={() => setShowForm(s => !s)}>{showForm ? 'Close' : '+ Plan wipe'}</button>}
      </div>

      {next && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 14, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div className="name" style={{ fontSize: 15 }}>{next.title}</div>
              {next.server_name && <div className="muted" style={{ fontSize: 13 }}>{next.server_name}</div>}
              {next.wipe_ts && <div className="muted" style={{ fontSize: 12 }}>{new Date(next.wipe_ts).toLocaleString()}</div>}
            </div>
            <div className="countdown">{fmtCountdown(next.wipe_ts)}</div>
          </div>
          {next.notes && <div className="muted" style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>{next.notes}</div>}
          <RsvpBar plan={next} mySteamId={mySteamId} onRsvp={r => act(() => api.rsvp(next.id, r))} />
          {next.rsvps.filter(r => r.response === 'yes').length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Going: {next.rsvps.filter(r => r.response === 'yes').map(r => nameOf(r.steam_id)).join(', ')}
            </div>
          )}
        </div>
      )}
      {!next && !showForm && <p style={{ fontSize: 14 }}>No wipe scheduled.{lead ? ' Plan one so everyone can RSVP.' : ''}</p>}

      {showForm && <WipeForm clanId={clan.clanId} onDone={() => { setShowForm(false); onChanged() }} />}

      {scheduled.filter(w => w !== next).map(w => (
        <div className="row" key={w.id}>
          <div className="row-main">
            <div style={{ minWidth: 0 }}>
              <div className="name">{w.title}</div>
              <div className="muted" style={{ fontSize: 12 }}>{w.wipe_ts ? new Date(w.wipe_ts).toLocaleString() : 'date TBD'}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>{w.rsvps.filter(r => r.response === 'yes').length} going</span>
            {lead && <button className="btn-ghost btn-sm" onClick={() => act(() => api.wipeStatus(w.id, 'cancelled'))}>✕</button>}
          </div>
        </div>
      ))}
      {err && <div className="error">{err}</div>}
    </div>
  )
}

function RsvpBar({ plan, mySteamId, onRsvp }: { plan: WipePlan; mySteamId: string; onRsvp: (r: string) => void }) {
  const mine = plan.rsvps.find(r => r.steam_id === mySteamId)?.response
  const counts = (r: string) => plan.rsvps.filter(x => x.response === r).length
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
      {(['yes', 'maybe', 'late', 'no'] as const).map(r => (
        <button key={r} className={`btn-sm ${mine === r ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onRsvp(r)}>
          {r === 'yes' ? '✔ Going' : r === 'maybe' ? '? Maybe' : r === 'late' ? '⏰ Late' : '✕ Out'} · {counts(r)}
        </button>
      ))}
    </div>
  )
}

function WipeForm({ clanId, onDone }: { clanId: string; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState('')
  const [server, setServer] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await api.createWipe(clanId, {
        title: title.trim(),
        wipeTs: when ? new Date(when).getTime() : null,
        serverName: server.trim(),
        notes: notes.trim(),
      })
      onDone()
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setBusy(false) }
  }

  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 14, marginBottom: 10 }}>
      <label>Title</label>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Force wipe — main server" maxLength={80} />
      <label>Date &amp; time</label>
      <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
      <label>Server (optional)</label>
      <input value={server} onChange={e => setServer(e.target.value)} placeholder="e.g. Rustoria Main" maxLength={80} />
      <label>Notes (optional)</label>
      <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Meet in Discord 30 min early…" />
      {err && <div className="error">{err}</div>}
      <div className="spacer" />
      <button className="btn-primary" disabled={busy || !title.trim()} onClick={submit}>Schedule wipe</button>
    </div>
  )
}
