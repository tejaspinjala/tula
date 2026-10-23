import { useEffect, useRef, useState } from 'react'

/**
 * The text a polite live region speaks for the room the Guild Master is in, so a screen reader
 * hears each room change once. `text` is only taken up when `room` changes and `ready` says every
 * input has caught up with the new room (the mini map is drawn a render after the scene moves), so
 * a stale summary of the room just left is never spoken; a count that changes inside the same room
 * (unread Inquiries, a Seal) does not repeat the announcement.
 */
export function useRoomAnnouncement(room: string, ready: boolean, text: string): string {
  const latest = useRef(text)
  latest.current = text
  const [spoken, setSpoken] = useState(text)
  const [spokenFor, setSpokenFor] = useState<string | null>(ready ? room : null)
  useEffect(() => {
    if (ready && spokenFor !== room) {
      setSpoken(latest.current)
      setSpokenFor(room)
    }
  }, [room, ready, spokenFor])
  return spoken
}
