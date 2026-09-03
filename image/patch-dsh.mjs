import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
const path = require.resolve('@deepseek-ai/dsh-web-app/startup')
const source = readFileSync(path, 'utf8')
const guard = 'options.host === "0.0.0.0"'
if (source.split(guard).length !== 2) throw new Error('DSH listener patch drifted; review the new package before building')
writeFileSync(path, source.replace(guard, 'false /* Portal container listener */'))
