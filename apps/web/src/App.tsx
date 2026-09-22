import { Routes, Route } from 'react-router-dom'
import { ThemeProvider, trailhead } from '@hcsneden/design-library'
import { AuthPage } from './pages/AuthPage'
import { MapPage } from './pages/MapPage'

// The map is public. Searching and reading a parcel need no account, the same
// way a listing site works. Only saving a parcel does, and that is gated at the
// button rather than here, so a visitor never hits a wall before seeing anything.
export default function App() {
  return (
    <ThemeProvider theme={trailhead}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/*" element={<MapPage />} />
      </Routes>
    </ThemeProvider>
  )
}
