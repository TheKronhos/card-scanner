import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its double-mounted effects would add extra history entries for sheets (see ui/nav.ts).
createRoot(document.getElementById('root')!).render(<App />)
