import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { authApi } from '../services/api'
import { useStore } from '../store'

export function AuthPage() {
  const navigate = useNavigate()
  const setAuth = useStore((s) => s.setAuth)

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const res = mode === 'login'
      ? await authApi.login(email, password)
      : await authApi.register(email, password)

    setLoading(false)

    if (!res.success || !res.data) {
      setError(res.error?.message ?? 'Something went wrong')
      return
    }

    setAuth(res.data.user, res.data.tokens)
    navigate('/')
  }

  return (
    <div className="auth-page">
      <div className="auth-aside">
        <div className="auth-topo" />
        <div className="auth-aside-content">
          <div className="auth-aside-logo">
            Land<span>Finder</span>
          </div>
          <p className="auth-aside-tagline">
            Complete due diligence on Montana land before you make an offer.
            Water rights, road access, buildability, and environmental risk — in one place.
          </p>
          <div className="auth-aside-features">
            {[
              'DNRC water rights with priority dates',
              'Landlocked and access warnings',
              'Conservation easement status',
              'Wildfire risk and mining history',
              'Interactive GIS layer overlays',
            ].map((f) => (
              <div key={f} className="auth-feature">
                <div className="auth-feature-dot" />
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="auth-form-wrap">
        <h1 className="auth-form-title">
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="auth-form-sub">
          {mode === 'login'
            ? 'Continue your land research'
            : 'Start researching Montana land'}
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
          {error && <div className="auth-error">{error}</div>}

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="auth-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="auth-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 8 characters' : ''}
              required
              minLength={mode === 'register' ? 8 : undefined}
            />
          </div>

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading && <span className="spinner" style={{ borderTopColor: 'white' }} />}
            {loading
              ? mode === 'login' ? 'Signing in…' : 'Creating account…'
              : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}>
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  )
}
