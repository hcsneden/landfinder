import { Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider, trailhead } from '@hcsneden/design-library'
import { useStore } from './store'
import { AuthPage } from './pages/AuthPage'
import { MapPage } from './pages/MapPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const tokens = useStore((s) => s.tokens)
  if (!tokens) return <Navigate to="/auth" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <ThemeProvider theme={trailhead}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <MapPage />
            </RequireAuth>
          }
        />
      </Routes>
    </ThemeProvider>
  )
}
