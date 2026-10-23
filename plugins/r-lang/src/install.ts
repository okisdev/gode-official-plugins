import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findProgram, PluginError } from '@gode/plugin-sdk/plugin'

export const languageServerVersion = '0.3.19'
const sourceUrl = `https://cran.r-project.org/src/contrib/Archive/languageserver/languageserver_${languageServerVersion}.tar.gz`
const sourceSha256 = 'd6410c6a3fd4baca81db29c446d0cf8ba4a40d3c53652bc379ff51801f6511e2'
const dependencies = [
  'callr',
  'collections',
  'digest',
  'fs',
  'jsonlite',
  'lintr',
  'R6',
  'roxygen2',
  'stringi',
  'styler',
  'xml2',
  'xmlparsedata',
]
const run = promisify(execFile)
const installs = new Map<string, Promise<string>>()

async function installed(library: string): Promise<boolean> {
  try {
    const description = await readFile(join(library, 'languageserver', 'DESCRIPTION'), 'utf8')
    return new RegExp(`^Version: ${languageServerVersion}$`, 'm').test(description)
  } catch {
    return false
  }
}

async function ready(target: string): Promise<boolean> {
  try {
    await access(join(target, 'language-server'), constants.X_OK)
    return installed(join(target, 'library'))
  } catch {
    return false
  }
}

async function downloadSource(path: string): Promise<void> {
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`CRAN download failed: ${response.status}`)
  const source = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(source).digest('hex') !== sourceSha256)
    throw new Error('CRAN languageserver archive failed SHA-256 verification')
  await writeFile(path, source)
}

async function install(
  directory: string,
  rscript: string,
  download: (path: string) => Promise<void>,
): Promise<string> {
  const parent = join(directory, 'languageserver')
  const target = join(parent, languageServerVersion)
  const launcher = join(target, 'language-server')
  if (await ready(target)) return launcher

  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, '.install-'))
  try {
    const tempLibrary = join(temporary, 'library')
    const archive = join(temporary, 'languageserver.tar.gz')
    await mkdir(tempLibrary)
    await download(archive)
    await run(
      rscript,
      [
        '--vanilla',
        '-e',
        `
      args <- commandArgs(TRUE)
      lib <- args[1]
      .libPaths(c(lib, .Library))
      install.packages(c(${dependencies.map((name) => JSON.stringify(name)).join(', ')}), lib=lib, repos='https://cloud.r-project.org', dependencies=NA, quiet=TRUE)
      install.packages(args[2], lib=lib, repos=NULL, type='source', quiet=TRUE)
      if (as.character(packageVersion('languageserver', lib.loc=lib)) != '${languageServerVersion}') stop('Wrong languageserver version')
    `,
        tempLibrary,
        archive,
      ],
      {
        env: {
          ...process.env,
          R_LIBS: tempLibrary,
          R_LIBS_USER: tempLibrary,
          R_LIBS_SITE: tempLibrary,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    if (!(await installed(tempLibrary))) throw new Error('R did not install languageserver')
    await rm(archive)
    await writeFile(
      join(temporary, 'language-server'),
      '#!/bin/sh\nexec "$GODE_R" --slave --vanilla -e "languageserver::run()"\n',
      { mode: 0o755 },
    )
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!(await ready(target))) throw error
    }
    return launcher
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function installLanguageserver(
  directory: string,
  rscript = findProgram('Rscript'),
  r = findProgram('R'),
  download = downloadSource,
): Promise<{ path: string; env: Record<string, string> }> {
  if (!rscript || !r) throw new PluginError({ message: 'missing' })
  const pending = installs.get(directory)
  const promise = pending ?? install(directory, rscript, download)
  if (!pending) installs.set(directory, promise)
  try {
    const path = await promise
    const library = join(directory, 'languageserver', languageServerVersion, 'library')
    return {
      path,
      env: {
        GODE_R: r,
        R_LIBS: library,
        R_LIBS_USER: library,
        R_LIBS_SITE: library,
        R_PROFILE_USER: '/dev/null',
        R_ENVIRON_USER: '/dev/null',
      },
    }
  } finally {
    if (!pending) installs.delete(directory)
  }
}
