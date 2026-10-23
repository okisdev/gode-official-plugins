import { spawnSync } from 'node:child_process'
import { delimiter } from 'node:path'
import { findProgram } from '@gode/plugin-sdk/plugin'

export function findJava(searchPath = process.env.PATH ?? ''): string | undefined {
  for (const directory of searchPath.split(delimiter)) {
    const java = findProgram('java', directory)
    if (!java) continue
    const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 5000 })
    const version = /(?:openjdk|java) version "(\d+)[."]/.exec(result.stderr)
    if (result.status === 0 && version && Number(version[1]) >= 17) return java
  }
  return undefined
}
