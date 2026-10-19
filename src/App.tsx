import { Route, Routes } from 'react-router'
import { MiniProgramShell } from './components/MiniProgramShell'
import { GdPage } from './pages/GdPage'
import { HomePage } from './pages/HomePage'
import { ScaffoldPage } from './pages/ScaffoldPage'

export default function App() {
  return (
    <MiniProgramShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/gd" element={<GdPage />} />
        <Route
          path="/discover"
          element={<ScaffoldPage variant="discover" />}
        />
        <Route
          path="/me"
          element={<ScaffoldPage variant="me" />}
        />
        <Route path="*" element={<ScaffoldPage variant="not-found" />} />
      </Routes>
    </MiniProgramShell>
  )
}
