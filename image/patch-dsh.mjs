import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')

function patch(specifier, guard, replacement, message) {
  const path = require.resolve(specifier)
  const source = readFileSync(path, 'utf8')
  const guardCount = source.split(guard).length - 1
  const replacementCount = source.split(replacement).length - 1
  if (guardCount === 0 && replacementCount === 1) return
  if (guardCount !== 1 || replacementCount !== 0) throw new Error(message)
  writeFileSync(path, source.replace(guard, replacement))
}

patch('@deepseek-ai/dsh-web-app/startup', 'options.host === "0.0.0.0"',
  'false /* Portal container listener */', 'DSH listener patch drifted; review the new package before building')
patch('@deepseek-ai/dsh-client-ui-settings/client',
  'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";',
  'const persistence = "host"; /* Portal-authenticated remote browser */',
  'DSH remote settings patch drifted; review the new package before building')
