import { expect, test } from 'bun:test'
import { QUEST_TEMPLATES } from '../../../guildd/src/quests'
import { QUEST_TEMPLATE_CHOICES } from './templates'

test('the picker templates match the server Quest templates', () => {
  expect(QUEST_TEMPLATE_CHOICES).toEqual(
    QUEST_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      hallId: t.hallId,
      requiresSeal: t.requiresSeal,
    }))
  )
})
