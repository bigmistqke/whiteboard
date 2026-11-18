// Links to a GitHub or GitLab repository's issues and pull/merge requests, as written in a page's
// text: `#12` is issue 12, `!34` pull or merge request 34, and `owner/repo#12` or
// `group/project!34` the same in another repository on the same host. Which repository is read
// from the project's `origin` remote (https or ssh), so self-hosted GitLab works too; without one,
// or one that is neither GitHub nor GitLab, it links nothing. `forge({ repo, host, kind })` in the
// config says it instead. Links only: nothing is fetched.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { definePlugin, type Plugin, type TextLink } from '@bigmistqke/whiteboard'

export type ForgeKind = 'github' | 'gitlab'
export interface Forge {
  kind: ForgeKind
  host: string
  repo: string
}

/** A git remote's URL → its host and repository path: https, ssh (`git@host:path`), ssh://. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const u = url.trim()
  const scp = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(u)
  if (scp) return { host: scp[1], repo: scp[2] }
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u)
  if (full) return { host: full[1], repo: full[2] }
  return null
}

/** GitHub or GitLab, by the host's name; null for any other. */
export const kindOf = (host: string): ForgeKind | null =>
  /(^|\.)github\./.test(host) ? 'github' : /(^|\.)gitlab\./.test(host) || /^gitlab/.test(host) ? 'gitlab' : null

/** The links for one forge: issues (`#n`) and pull or merge requests (`!n`), here or in `owner/repo`. */
export function forgeLinks({ kind, host, repo }: Forge): TextLink[] {
  const base = (path: string | undefined) => `https://${host}/${path ?? repo}`
  // after the start, a space or punctuation, so `C#1`, `a/b.md#12` and `x!3` stay text; an optional
  // repository in front (`owner/repo#12`); then the number, ending at a word's end
  const ref = (sign: string) => new RegExp(`(?<![\\w/.#!-])(?:([\\w.-]+(?:/[\\w.-]+)+))?${sign}(\\d+)(?![\\w-])`, 'g')
  const issue = kind === 'github' ? 'issues' : '-/issues'
  const change = kind === 'github' ? 'pull' : '-/merge_requests'
  const what = kind === 'github' ? 'pull request' : 'merge request'
  return [
    { pattern: ref('#'), href: m => `${base(m[1])}/${issue}/${m[2]}`, title: m => `issue ${m[1] ?? repo}#${m[2]}` },
    { pattern: ref('!'), href: m => `${base(m[1])}/${change}/${m[2]}`, title: m => `${what} ${m[1] ?? repo}!${m[2]}` },
  ]
}

/** The project's forge, from its `origin` remote; null without one it knows. */
export function detect(dir: string): Forge | null {
  let url: string
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const remote = parseRemote(url)
  const kind = remote && kindOf(remote.host)
  return remote && kind ? { kind, ...remote } : null
}

export interface ForgeOptions {
  /** the repository's path on its host: `owner/repo`, `group/subgroup/project` */
  repo?: string
  /** github.com, gitlab.com, or a self-hosted GitLab's host */
  host?: string
  kind?: ForgeKind
}

export default function forge(options: ForgeOptions = {}): Plugin {
  return definePlugin({
    name: 'forge',
    links({ dir }) {
      const found = detect(dir)
      const host = options.host ?? found?.host
      const repo = options.repo ?? found?.repo
      const kind = options.kind ?? (options.host ? kindOf(options.host) : null) ?? found?.kind
      return host && repo && kind ? forgeLinks({ kind, host, repo }) : []
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
