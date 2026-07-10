import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, ClanDetail, MyClanResponse, WipePlan } from './api'

/* ClanBot Platform — the website-side Clan Manager. Works with zero bot
   involvement; when a clan is deployment-backed, "Wipe tools" links through
   the existing SSO launcher into the full Rust+ dashboard. */

const CAN_LEAD = (role?: string | null) => role === 'owner' || role === 'leader'

function initials(name: string | null, steamId: string) {
  const n = (name || '').trim()
  if (n) return n.slice(0, 2).toUpperCase()
  return steamId.slice(-2)
}

function fmtCountdown(ts: number | null): string {
  if (!ts) return 'TBD'
  const ms = ts - Date.now()
  if (ms <= 0) return 'live now'
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

function roleBadge(role: string) {
  return <span className={`badge role-${role}`}>{role}</span>
}

/* ── Shell ────────────────────────────────────────────────────────────── */

export default function App() {
  const joinCode = useMemo(() => {
    const m = window.location.pathname.match(/^\/join\/([a-zA-Z0-9]+)/)
    return m ? m[1] : null
  }, [])

  const [data, setData] = useState<MyClanResponse | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')

  const reload = useCallback(async (clanId?: string) => {
    try {
      const d = await api.myclan(clanId)
      setData(d); setSignedIn(true); setError('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSignedIn(false)
      else setError(e instanceof Error ? e.message : 'failed to load')
    }
  }, [])

  useEffect(() => { reload(selected) }, [reload, selected])

  return (
    <div className="container">
      <div className="topbar">
        <a className="wordmark" href="/">Clan<em>Bot</em> <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· Clan Manager</span></a>
        <div className="topbar-right">
          {data && data.clans.length > 1 && (
            <select style={{ width: 'auto' }} value={data.clan?.clanId || ''} onChange={e => setSelected(e.target.value)}>
              {data.clans.map(c => <option key={c.clanId} value={c.clanId}>{c.name}</option>)}
            </select>
          )}
          <a className="btn btn-ghost btn-sm" href="/account">Account</a>
        </div>
      </div>

      {error && <div className="card" style={{ marginBottom: 14 }}><span className="error">{error}</span></div>}

      {signedIn === false
        ? <SignedOut joinCode={joinCode} />
        : joinCode
          ? <JoinPage code={joinCode} onJoined={id => { history.replaceState(null, '', '/clan'); setSelected(id); reload(id) }} />
          : !data
            ? <div className="center muted">Loading…</div>
            : data.clan
              ? <ClanHome clan={data.clan} mySteamId={data.steamId} onChanged={() => reload(data.clan!.clanId)} />
              : <NoClan onCreated={id => { setSelected(id); reload(id) }} />}
    </div>
  )
}

function SignedOut({ joinCode }: { joinCode: string | null }) {
  return (
    <div className="card center">
      <h1>Run your clan from one place</h1>
      <p>{joinCode ? 'Sign in with Steam to accept this clan invite.' : 'Roster, wipe planning and more — sign in with Steam to get started.'}</p>
      <div className="spacer" />
      <a className="btn btn-primary" href="/auth/steam">Sign in with Steam</a>
    </div>
  )
}

/* ── Create / Join ────────────────────────────────────────────────────── */

function NoClan({ onCreated }: { onCreated: (clanId: string) => void }) {
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const create = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.create(name.trim(), tag.trim())
      onCreated(String(r.clanId))
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
    setBusy(false)
  }

  return (
    <div className="card" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h1>Create your clan</h1>
      <p>Set up a clan in seconds. Invite members with a link — no bot required. Add the Rust+ package later for full wipe-time power.</p>
      <label>Clan name</label>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Back To Basics" maxLength={48} />
      <label>Tag (optional)</label>
      <input value={tag} onChange={e => setTag(e.target.value)} placeholder="e.g. B2B" maxLength={8} />
      {err && <div className="error">{err}</div>}
      <div className="spacer" />
      <button className="btn-primary" disabled={busy || !name.trim()} onClick={create}>Create clan</button>
      <p style={{ fontSize: 13, marginTop: 14 }}>Got an invite link? Just open it and you'll join automatically.</p>
    </div>
  )
}

function JoinPage({ code, onJoined }: { code: string; onJoined: (clanId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const join = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.join(code)
      onJoined(String(r.clanId))
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setBusy(false) }
  }
  return (
    <div className="card center" style={{ maxWidth: 480, margin: '40px auto' }}>
      <h1>Join clan</h1>
      <p>You've been invited. Invite code:</p>
      <div className="mono" style={{ fontSize: 16, margin: '6px 0 18px' }}>{code}</div>
      {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
      <button className="btn-primary" disabled={busy} onClick={join}>Accept invite</button>
    </div>
  )
}

/* ── Clan home ────────────────────────────────────────────────────────── */

function ClanHome({ clan, mySteamId, onChanged }: {
  clan: ClanDetail; mySteamId: string; onChanged: () => void
}) {
  const lead = CAN_LEAD(clan.myRole)
  return (
    <>
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>{clan.name} {clan.tag && <span className="muted" style={{ fontSize: 16 }}>[{clan.tag}]</span>}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {roleBadge(clan.myRole)}
            <span className="muted" style={{ fontSize: 13 }}>{clan.roster.length} member{clan.roster.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        {clan.deploymentGuildId && (
          <a className="btn btn-primary" href={`/sso/launch?guild_id=${encodeURIComponent(clan.deploymentGuildId)}`}>
            ⚡ Wipe tools →
          </a>
        )}
      </div>

      <div className="grid2">
        <WipesCard clan={clan} lead={lead} mySteamId={mySteamId} onChanged={onChanged} />
        <RosterCard clan={clan} lead={lead} mySteamId={mySteamId} onChanged={onChanged} />
      </div>
    </>
  )
}

/* ── Roster ───────────────────────────────────────────────────────────── */

function RosterCard({ clan, lead, mySteamId, onChanged }: {
  clan: ClanDetail; lead: boolean; mySteamId: string; onChanged: () => void
}) {
  const [addId, setAddId] = useState('')
  const [addName, setAddName] = useState('')
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

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>👥 Roster</h2>
        {lead && <button className="btn-secondary btn-sm" onClick={invite}>🔗 Invite link</button>}
      </div>

      {clan.roster.map(m => (
        <div className="row" key={m.steam_id}>
          <div className="row-main">
            <div className="avatar">{initials(m.name, m.steam_id)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="name">{m.name || m.steam_id}{m.steam_id === mySteamId && <span className="muted"> (you)</span>}</div>
              <div className="mono">{m.steam_id}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {roleBadge(m.role)}
            {clan.myRole === 'owner' && m.role !== 'owner' && (
              <button className="btn-ghost btn-sm" title={m.role === 'leader' ? 'Demote to member' : 'Promote to leader'}
                onClick={() => act(() => api.setRole(clan.clanId, m.steam_id, m.role === 'leader' ? 'member' : 'leader'))}>
                {m.role === 'leader' ? '▾' : '▴'}
              </button>
            )}
            {lead && m.role !== 'owner' && m.steam_id !== mySteamId && (
              <button className="btn-ghost btn-sm" title="Remove"
                onClick={() => { if (confirm(`Remove ${m.name || m.steam_id} from the clan?`)) act(() => api.removeMember(clan.clanId, m.steam_id)) }}>
                ✕
              </button>
            )}
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
    </div>
  )
}

/* ── Wipes ────────────────────────────────────────────────────────────── */

function WipesCard({ clan, lead, mySteamId, onChanged }: {
  clan: ClanDetail; lead: boolean; mySteamId: string; onChanged: () => void
}) {
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
            </div>
            <div className="countdown">{fmtCountdown(next.wipe_ts)}</div>
          </div>
          <RsvpBar plan={next} mySteamId={mySteamId} onRsvp={r => act(() => api.rsvp(next.id, r))} />
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
