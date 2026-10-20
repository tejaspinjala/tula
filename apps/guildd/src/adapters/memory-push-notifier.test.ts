import { pushNotifierContract } from '../ports/push-notifier.contract'
import { MemoryPushNotifier } from './memory-push-notifier'

pushNotifierContract('memory', async () => {
  const notifier = new MemoryPushNotifier()
  return {
    notifier,
    markGone: (endpoint) => notifier.markGone(endpoint),
    delivered: async (endpoint) => notifier.sentTo(endpoint),
  }
})
