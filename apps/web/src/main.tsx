import './zod-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource/pixelify-sans/latin-400.css'
import '@fontsource/pixelify-sans/latin-700.css'
import '@fontsource/jersey-10/latin-400.css'
import '@fontsource/silkscreen/latin-400.css'
import '@fontsource/silkscreen/latin-700.css'
import '@fontsource/vt323/latin-400.css'
import '@xyflow/react/dist/style.css'
import './styles/tokens.css'
import './ui/pixel/pixel.css'
import './work.css'
import './index.css'
import './guildmap.css'
import './TitleScene.css'
import { bootTheme, browserThemeEnv } from './ui/pixel/theme'

// Day or night, from the saved Guild Master choice or the system, before the first paint of the app.
const themeEnv = browserThemeEnv()
if (themeEnv) {
  bootTheme(themeEnv)
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root element')
}

// The kitchen sink is development only; the DEV branch is removed from a production build.
async function pickPage() {
  if (import.meta.env.DEV) {
    const sink = await import('./ui/pixel/KitchenSink')
    if (sink.isKitchenSinkPath(window.location.pathname, true)) {
      return sink.KitchenSink
    }
  }
  return App
}

const Page = await pickPage()
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>
)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Installability is a nicety; the ledger view works without the worker.
  })
}
