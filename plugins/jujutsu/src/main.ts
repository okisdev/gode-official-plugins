import type { SourceControlMethods } from '@gode/plugin-sdk'
import { definePlugin } from '@gode/plugin-sdk/plugin'
import { createBranches } from './branches.ts'
import { createCheckouts } from './checkouts.ts'
import { createHistory } from './history.ts'
import { createRepository } from './repository.ts'
import { createSync } from './sync.ts'
import { createWorkingCopy } from './working-copy.ts'

type Routes = {
  [K in keyof SourceControlMethods]?: (params: SourceControlMethods[K]['params']) => unknown
}

export default definePlugin(({ log, setStatus }) => ({
  start() {
    setStatus({ state: 'ready', message: 'ready' })
  },
  call(message) {
    if (!message.method.startsWith('sourceControl.'))
      throw new Error(`Unknown method: ${message.method}`)
    const path = (message.params as { path: string }).path
    const repository = createRepository(path, log)
    const working = createWorkingCopy(path, log)
    const history = createHistory(path, log)
    const branches = createBranches(path, log)
    const sync = createSync(path, log)
    const checkouts = createCheckouts(path, log)
    const routes: Routes = {
      'sourceControl.repository': () => repository.repository(),
      'sourceControl.root': () => repository.root(),
      'sourceControl.files': () => repository.files(),
      'sourceControl.ignoredPaths': ({ paths }) => repository.ignoredPaths(paths),
      'sourceControl.trackedPaths': ({ paths }) => repository.trackedPaths(paths),
      'sourceControl.remotes': () => repository.remotes(),
      'sourceControl.userName': () => repository.userName(),
      'sourceControl.isAncestor': ({ id }) => repository.isAncestor(id),
      'sourceControl.commitsBetween': ({ from, to }) => repository.commitsBetween(from, to),
      'sourceControl.workingCopy.changes': () => working.changes(),
      'sourceControl.workingCopy.summaries': ({ changes, ignoringWhitespace }) =>
        working.summaries(changes, ignoringWhitespace),
      'sourceControl.workingCopy.fileDiff': ({
        side,
        file,
        previousPath,
        untracked,
        ignoringWhitespace,
      }) => working.fileDiff(side, file, previousPath, untracked, ignoringWhitespace),
      'sourceControl.workingCopy.diffFileText': ({ source, file }) =>
        working.diffFileText(source, file),
      'sourceControl.workingCopy.diffFilePictures': ({ source, file }) =>
        working.diffFilePictures(source, file),
      'sourceControl.workingCopy.branchStatus': () => working.branchStatus(),
      'sourceControl.workingCopy.discard': ({ tracked }) => working.discard(tracked),
      'sourceControl.workingCopy.commit': ({ message, options }) =>
        working.commit(message, options),
      'sourceControl.workingCopy.lastCommitMessage': () => working.lastCommitMessage(),
      'sourceControl.workingCopy.ignore': ({ patterns }) => working.ignore(patterns),
      'sourceControl.workingCopy.ignored': ({ paths }) => working.ignored(paths),
      'sourceControl.workingCopy.oversizedFiles': ({ paths, limit }) =>
        working.oversizedFiles(paths, limit),
      'sourceControl.workingCopy.watchTargets': () => working.watchTargets(),
      'sourceControl.history.recent': ({ limit }) => history.recent(limit),
      'sourceControl.history.ahead': () => history.ahead(),
      'sourceControl.history.unpushed': () => history.unpushed(),
      'sourceControl.history.commitsNotIn': ({ base }) => history.commitsNotIn(base),
      'sourceControl.history.commitDiff': ({ id, ignoringWhitespace }) =>
        history.commitDiff(id, ignoringWhitespace),
      'sourceControl.history.comparisonRange': ({ branch, side }) =>
        history.comparisonRange(branch, side),
      'sourceControl.history.rangeDiff': ({ from, to, ignoringWhitespace }) =>
        history.rangeDiff(from, to, ignoringWhitespace),
      'sourceControl.history.verifiedCommit': ({ id }) => history.verifiedCommit(id),
      'sourceControl.branches.list': () => branches.list(),
      'sourceControl.branches.switch': ({ name }) => branches.switch(name),
      'sourceControl.branches.create': ({ name, start, switching }) =>
        branches.create(name, start, switching),
      'sourceControl.branches.rename': ({ name, newName }) => branches.rename(name, newName),
      'sourceControl.branches.delete': ({ name, force }) => branches.delete(name, force),
      'sourceControl.branches.deleteRemote': ({ name, remote }) =>
        branches.deleteRemote(name, remote),
      'sourceControl.branches.compare': ({ branch }) => branches.compare(branch),
      'sourceControl.branches.invalidName': ({ name, existing }) =>
        branches.invalidName(name, existing),
      'sourceControl.sync.lastFetched': () => sync.lastFetched(),
      'sourceControl.sync.remoteBranches': () => sync.remoteBranches(),
      'sourceControl.sync.addRemote': ({ name, url }) => sync.addRemote(name, url),
      'sourceControl.sync.fetch': () => sync.fetch(),
      'sourceControl.sync.pull': ({ strategy }) => sync.pull(strategy),
      'sourceControl.sync.push': () => sync.push(),
      'sourceControl.sync.publish': ({ remote }) => sync.publish(remote),
      'sourceControl.checkouts.create': ({ options }) => checkouts.create(options),
      'sourceControl.checkouts.checkRemoval': ({ checkoutPath }) =>
        checkouts.checkRemoval(checkoutPath),
      'sourceControl.checkouts.remove': ({ checkoutPath, force }) =>
        checkouts.remove(checkoutPath, force),
    }
    const route = routes[message.method as keyof SourceControlMethods]
    if (!route) throw new Error(`Unsupported source-control method: ${message.method}`)
    return route(message.params as never)
  },
  error: () => ({ message: 'failed' }),
}))
