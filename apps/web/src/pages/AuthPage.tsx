import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Typography } from '@hcsneden/design-library'
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
        <div className="auth-form-head">
          <Typography variant="h3" as="h1">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Typography>
          <Typography variant="body-sm" muted>
            {mode === 'login'
              ? 'Continue your land research'
              : 'Start researching Montana land'}
          </Typography>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {error && <div className="auth-error">{error}</div>}

          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
          />

          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 8 characters' : ''}
            required
            minLength={mode === 'register' ? 8 : undefined}
          />

          <Button type="submit" variant="primary" size="lg" disabled={loading}>
            {loading && <span className="spinner" />}
            {loading
              ? mode === 'login' ? 'Signing in…' : 'Creating account…'
              : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="auth-switch">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </Button>
        </p>
      </div>
    </div>
  )
}
