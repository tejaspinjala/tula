import { type BuilderConfig, type BuilderHall, freshId, usedIds } from './model'

/** A prebuilt Hall the palette offers. */
export interface HallTemplate {
  id: string
  label: string
  hall: BuilderHall
}

const work = (hall: Pick<BuilderHall, 'id' | 'name' | 'captain' | 'members'>): BuilderHall => ({
  kind: 'work',
  locked: false,
  privateEligible: false,
  ...hall,
})

/** The prebuilt Halls. Add an entry here and the palette offers it; no other code changes. */
export const TEMPLATES: HallTemplate[] = [
  {
    id: 'heralds',
    label: 'Heralds',
    hall: work({
      id: 'heralds',
      name: 'Heralds Hall',
      captain: { id: 'heralds-captain', name: 'Herald Captain' },
      members: [
        { id: 'heralds-member-1', name: 'Herald Apprentice', rank: 'apprentice' },
        { id: 'heralds-member-2', name: 'Herald Journeyman', rank: 'journeyman' },
      ],
    }),
  },
  {
    id: 'research',
    label: 'Research',
    hall: work({
      id: 'research',
      name: 'Research Hall',
      captain: { id: 'research-captain', name: 'Research Captain' },
      members: [
        { id: 'research-member-1', name: 'Researcher', rank: 'journeyman' },
        { id: 'research-member-2', name: 'Research Assistant', rank: 'apprentice' },
      ],
    }),
  },
  {
    id: 'review',
    label: 'Review',
    hall: work({
      id: 'review',
      name: 'Review Hall',
      captain: { id: 'review-captain', name: 'Review Captain' },
      members: [{ id: 'review-member-1', name: 'Reviewer', rank: 'adept' }],
    }),
  },
]

/** Adds a prebuilt Hall to a config, giving the Hall, its Captain and Members fresh ids. */
export function instantiate(c: BuilderConfig, template: HallTemplate): BuilderConfig {
  const taken = usedIds(c)
  const claim = (base: string) => {
    const id = freshId(base, taken)
    taken.add(id)
    return id
  }
  const { hall } = template
  const added: BuilderHall = {
    ...hall,
    id: claim(hall.id),
    captain: hall.captain && { ...hall.captain, id: claim(hall.captain.id) },
    members: hall.members.map((m) => ({ ...m, id: claim(m.id) })),
  }
  return { ...c, halls: [...c.halls, added] }
}
