import { expect, test } from 'bun:test'
import { POSTABLE_TEMPLATES } from '../../../guildd/src/quests'
import { QUEST_TEMPLATE_CHOICES } from './templates'

test('the picker templates match the server Quest templates that can be posted (internal ones are left out)', () => {
  expect(QUEST_TEMPLATE_CHOICES).toEqual(
    POSTABLE_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      hallId: t.hallId,
      requiresSeal: t.requiresSeal,
    }))
  )
})
