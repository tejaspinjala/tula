import { z } from 'zod'

/**
 * Side-effect module, imported first by the entry point: Zod 4 otherwise probes `new Function`
 * on load, which the page's CSP (no `unsafe-eval`) reports as a violation. Jitless parsing is
 * slower but identical in behaviour.
 */
z.config({ jitless: true })
