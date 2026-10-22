import { useCallback, useEffect, useState } from 'react'
import { AwayScroll } from './AwayScroll'
import { Bag } from './Bag'
import { type GameLoader, GamePanel } from './GamePanel'
import { Hud } from './Hud'
import { endSession, type Session } from './passkeys'
import { BAG_PAGES, useRoute } from './router'

/**
 * The signed-in game: the Guild Hall fills the screen, a HUD sits over it, and the Bag opens
 * every other page as a framed overlay. There is no page navigation, only the world and the Bag.
 */
export function Shell({
  session,
  guildName,
  status,
  onSession,
  loadGame,
}: {
  session: Session
  guildName: string
  status: 'checking' | 'ok' | 'down'
  onSession: (session: Session | null) => void
  /** Loads the game module; tests swap it for a fake. */
  loadGame?: GameLoader | undefined
}) {
  const { page, navigate } = useRoute()
  const [bagOpen, setBagOpen] = useState(false)
  const visible = bagOpen || page !== null
  const active = BAG_PAGES.find((p) => p.id === page)
  // Any path that names a Bag page (a Seal desk, a Member's Quest) opens the Bag over the world.
  const openPath = useCallback(
    (path: string) => {
      setBagOpen(true)
      navigate(path)
    },
    [navigate]
  )
  const showMenu = useCallback(() => {
    setBagOpen(true)
    navigate('/')
  }, [navigate])
  const close = useCallback(() => {
    setBagOpen(false)
    navigate('/')
  }, [navigate])
  // B opens the Bag from the walk, and closes it from its menu. Typing in a field never triggers it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || event.ctrlKey || event.metaKey || event.altKey) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          (!visible && target.closest('dialog') !== null))
      ) {
        return
      }
      event.preventDefault()
      if (!visible) {
        showMenu()
      } else if (page === null) {
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, page, showMenu, close])
  useEffect(() => {
    document.title = active ? `${active.label} | Guildhall` : 'Guildhall'
  }, [active])
  useEffect(() => {
    return () => {
      document.title = 'Guildhall'
    }
  }, [])
  const signOut = async () => {
    await endSession(fetch)
    navigate('/')
    onSession(null)
  }
  return (
    <main id="main" tabIndex={-1} className="shell">
      <GamePanel session={session} navigate={openPath} inputEnabled={!visible} loadGame={loadGame}>
        {({ hallControls, focusWorld, talkTo, refreshHall }) => (
          <>
            <Hud
              session={session}
              guildName={guildName}
              status={status}
              refresh={visible ? 0 : 1}
              onOpenBag={showMenu}
              onOpenSeals={() => openPath('/seals')}
            />
            <AwayScroll
              session={session}
              onShow={close}
              onOpenCouncil={(id) => openPath(`/council?session=${encodeURIComponent(id)}`)}
            />
            <Bag
              session={session}
              onSession={onSession}
              visible={visible}
              page={page}
              hallControls={hallControls}
              onOpenPath={openPath}
              onMenu={showMenu}
              onClose={close}
              onSignOut={signOut}
              focusWorld={focusWorld}
              onConfigChanged={refreshHall}
              onTalkTo={(id) => {
                close()
                talkTo(id)
              }}
            />
          </>
        )}
      </GamePanel>
    </main>
  )
}
