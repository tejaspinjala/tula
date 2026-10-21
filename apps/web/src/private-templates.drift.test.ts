import { expect, test } from 'bun:test'
import { POSTABLE_TEMPLATES } from '../../guildd/src/quests'
import { templatesFor } from './assign'
import { QUEST_TEMPLATES as FORM_TEMPLATES } from './quests'
import { QUEST_TEMPLATE_CHOICES } from './workflows/templates'

const privateOnServer = POSTABLE_TEMPLATES.filter((t) => t.dataClass === 'private')

test('the server has the three private templates', () => {
  expect(privateOnServer.map((t) => t.id).sort()).toEqual([
    'health-log',
    'personal-plan',
    'relationship-note',
  ])
})

test.each(privateOnServer.map((t) => [t.id, t] as const))(
  'private template %s is in every web copy with the server Hall and Seal need',
  (_id, server) => {
    expect(templatesFor(server.hallId).find((t) => t.id === server.id)).toMatchObject({
      name: server.name,
      hallId: server.hallId,
    })
    expect(FORM_TEMPLATES.find((t) => t.id === server.id)).toMatchObject({
      name: server.name,
      hallId: server.hallId,
    })
    expect(QUEST_TEMPLATE_CHOICES.find((t) => t.id === server.id)).toEqual({
      id: server.id,
      name: server.name,
      hallId: server.hallId,
      requiresSeal: server.requiresSeal,
    })
  }
)
