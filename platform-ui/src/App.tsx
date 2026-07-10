import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, ClanDetail, MyClanResponse } from './api'
import { ActiveClanCard, AnnouncementsCard, ApplicationsCard, CAN_LEAD, RosterCard, WipesCard } from './cards'

/* ClanBot Platform — the website-side Clan Manager. Works with zero bot
   involvement; when a clan is deployment-backed, "Wipe tools" links through
   the existing SSO launcher into the full Rust+ dashboard. */

export default function App() {
  const route = useMemo(() => {
    const join = window.location.pathname.match(/^\/join\/([a-zA-Z0-9]+)/)
    if (join) return { kind: 'join' as const, code: join[1] }
    const apply = window.location.pathname.match(/^\/apply\/([a-zA-Z0-9]+)/)
    if (apply) return { kind: 'apply' as const, clanId: apply[1] }
    return { kind: 'home' as const }
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
        ? <SignedOut route={route.kind} />
        : route.kind === 'join'
          ? <JoinPage code={route.code} onJoined={id => { history.replaceState(null, '', '/clan'); setSelected(id); reload(id) }} />
          : route.kind === 'apply'
            ? <ApplyPage clanId={route.clanId} />
            : !data
              ? <div className="center muted">Loading…</div>
              : data.clan
                ? <ClanHome clan={data.clan} mySteamId={data.steamId} onChanged={() => reload(data.clan!.clanId)} />
                : <NoClan onCreated={id => { setSelected(id); reload(id) }} />}
    </div>
  )
}

function SignedOut({ route }: { route: string }) {
  const blurb = route === 'join' ? 'Sign in with Steam to accept this clan invite.'
    : route === 'apply' ? 'Sign in with Steam to apply to this clan.'
    : 'Roster, wipe planning, recruitment and more — sign in with Steam to get started.'
  return (
    <div className="card center">
      <h1>Run your clan from one place</h1>
      <p>{blurb}</p>
      <div className="spacer" />
      <a className="btn btn-primary" href="/auth/steam">Sign in with Steam</a>
    </div>
  )
}

/* ── Create / Join / Apply ────────────────────────────────────────────── */

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

function ApplyPage({ clanId }: { clanId: string }) {
  const [info, setInfo] = useState<{ name: string; tag: string | null; open: boolean; alreadyMember: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'form' | 'sent'>('form')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.applyInfo(clanId).then(setInfo).catch(e => setErr(e instanceof Error ? e.message : 'failed'))
  }, [clanId])

  const submit = async () => {
    setBusy(true); setErr('')
    try { await api.apply(clanId, message.trim()); setState('sent') }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setBusy(false) }
  }

  if (!info) return <div className="center muted">{err || 'Loading…'}</div>
  return (
    <div className="card" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h1>Apply to {info.name} {info.tag && <span className="muted" style={{ fontSize: 16 }}>[{info.tag}]</span>}</h1>
      {info.alreadyMember ? (
        <p>You're already a member of this clan. <a href="/clan" style={{ color: 'var(--accent)' }}>Open the Clan Manager →</a></p>
      ) : !info.open ? (
        <p>This clan isn't taking applications right now.</p>
      ) : state === 'sent' ? (
        <>
          <p>✅ Application sent. The clan's leaders will review it — check back later.</p>
          <a className="btn btn-secondary" href="/clan">Go to Clan Manager</a>
        </>
      ) : (
        <>
          <p>Tell them a bit about yourself — hours, playstyle, who referred you.</p>
          <label>Message (optional)</label>
          <textarea rows={4} value={message} onChange={e => setMessage(e.target.value)} maxLength={1000}
            placeholder="2k hours, EU, builder main…" />
          {err && <div className="error">{err}</div>}
          <div className="spacer" />
          <button className="btn-primary" disabled={busy} onClick={submit}>Send application</button>
        </>
      )}
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge role-${clan.myRole}`}>{clan.myRole}</span>
            <span className="muted" style={{ fontSize: 13 }}>{clan.roster.length} member{clan.roster.length === 1 ? '' : 's'}</span>
            {lead && clan.pendingApplications > 0 && (
              <span className="badge rsvp-maybe">{clan.pendingApplications} application{clan.pendingApplications === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
        {clan.deploymentGuildId && (
          <a className="btn btn-primary" href={`/sso/launch?guild_id=${encodeURIComponent(clan.deploymentGuildId)}`}>
            ⚡ Wipe tools →
          </a>
        )}
      </div>

      <AnnouncementsCard clan={clan} lead={lead} onChanged={onChanged} />
      {lead && <ApplicationsCard clan={clan} onChanged={onChanged} />}

      <div className="grid2">
        <WipesCard clan={clan} mySteamId={mySteamId} onChanged={onChanged} />
        <RosterCard clan={clan} mySteamId={mySteamId} onChanged={onChanged} />
      </div>

      {clan.deploymentGuildId && <ActiveClanCard clan={clan} onChanged={onChanged} />}
    </>
  )
}
