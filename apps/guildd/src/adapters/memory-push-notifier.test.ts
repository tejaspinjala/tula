import { pushNotifierContract } from '../ports/push-notifier.contract'
import { MemoryPushNotifier } from './memory-push-notifier'

pushNotifierContract('memory', async () => {
  const notifier = new MemoryPushNotifier()
  return {
    notifier,
    subscribe: (endpoint) => ({ endpoint, p256dh: 'unused', auth: 'unused' }),
    markGone: (endpoint) => notifier.markGone(endpoint),
    delivered: async (endpoint) => notifier.sentTo(endpoint),
  }
})
