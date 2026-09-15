import { useActionState, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Typography } from '@hcsneden/design-library'
import { authApi } from '../services/api'
import { useStore } from '../store'

const FEATURES = [
  'DNRC water rights with priority dates',
  'Landlocked and access warnings',
  'Conservation easement status',
  'Wildfire risk and mining history',
  'Interactive GIS layer overlays',
]

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')

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
            {FEATURES.map((f) => (
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

        {/* key remounts AuthForm on mode switch, resetting action state and clearing errors */}
        <AuthForm key={mode} mode={mode} />

        <p className="auth-switch">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode((currentMode) => (currentMode === "login" ? "register" : "login"))}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </Button>
        </p>
      </div>
    </div>
  )
}

function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const navigate = useNavigate()
  const setAuth = useStore((state) => state.setAuth)

  const [error, formAction, isPending] = useActionState(
    async (_prev: string | null, formData: FormData) => {
      const email = formData.get('email') as string
      const password = formData.get('password') as string
      const res = mode === 'login'
        ? await authApi.login(email, password)
        : await authApi.register(email, password)
      if (!res.success || !res.data) return res.error?.message ?? 'Something went wrong'
      setAuth(res.data.user, res.data.tokens)
      navigate('/')
      return null
    },
    null,
  )

  return (
    <form className="auth-form" action={formAction}>
      {!isPending && error && <div className="auth-error">{error}</div>}

      <Input
        label="Email"
        type="email"
        name="email"
        placeholder="you@example.com"
        required
        autoFocus
      />

      <Input
        label="Password"
        type="password"
        name="password"
        placeholder={mode === 'register' ? 'At least 8 characters' : ''}
        required
        minLength={mode === 'register' ? 8 : undefined}
      />

      <Button type="submit" variant="primary" size="lg" disabled={isPending}>
        {isPending && <span className="spinner" />}
        {isPending
          ? mode === 'login' ? 'Signing in…' : 'Creating account…'
          : mode === 'login' ? 'Sign in' : 'Create account'}
      </Button>
    </form>
  )
}
