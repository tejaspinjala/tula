import { websocket } from './app'
import { compose } from './composition'
import { loadEnv } from './env'

const env = loadEnv()
const { app } = compose()

export default { port: env.PORT, fetch: app.fetch, websocket }
