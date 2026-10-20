#!/usr/bin/env bun
// Test fixture standing in for the `claude` CLI. It emits the JSON shape `claude -p
// --output-format json` prints. The first line of stdin picks the behaviour (`MODE=<name>`), so
// a test steers it through the prompt without any environment the adapter would strip.
const stdin = await new Response(Bun.stdin.stream()).text()
const mode = /^MODE=(\S+)/.exec(stdin)?.[1] ?? 'ok'
const usage = {
  input_tokens: 11,
  output_tokens: 5,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
}
const base = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, usage }
const emit = (body: object) => process.stdout.write(JSON.stringify({ ...base, ...body }))

if (mode === 'argv') {
  emit({ result: JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin }) })
} else if (mode === 'error') {
  emit({ subtype: 'error_during_execution', is_error: true, result: 'something broke' })
  process.exit(1)
} else if (mode === 'error0') {
  emit({ subtype: 'error_during_execution', is_error: true, result: 'something broke' })
} else if (mode === 'limit') {
  emit({ is_error: true, result: 'Claude AI usage limit reached|1760000000' })
  process.exit(1)
} else if (mode === 'garbage') {
  process.stdout.write('this is not json')
} else if (mode === 'exit3') {
  process.exit(3)
} else if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'big') {
  process.stdout.write('x'.repeat(2_000_000))
} else if (mode === 'slow') {
  const start = Date.now()
  await Bun.sleep(300)
  emit({ result: JSON.stringify({ start, end: Date.now() }) })
} else {
  emit({ result: 'hello from claude' })
}
