import { useEffect, useState } from 'react'

/** Ledger-view shell: a single page that reports whether guildd is healthy. */
export function App() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
  }, [])

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Guildhall ledger</h1>
      <p className="mt-4">guildd: {status}</p>
    </main>
  )
}
