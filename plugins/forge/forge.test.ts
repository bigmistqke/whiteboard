import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgeLinks, kindOf, parseRemote } from './index.ts'
import { renderMarkdown } from '../../src/pages/markdown.ts'

test('forge: a remote URL gives its host and repository, https or ssh', () => {
  assert.deepEqual(parseRemote('https://github.com/bigmistqke/whiteboard.git'), {
    host: 'github.com',
    repo: 'bigmistqke/whiteboard',
  })
  assert.deepEqual(parseRemote('git@gitlab.example.com:group/sub/project.git\n'), {
    host: 'gitlab.example.com',
    repo: 'group/sub/project',
  })
  assert.deepEqual(parseRemote('ssh://git@gitlab.com:2222/group/project'), {
    host: 'gitlab.com',
    repo: 'group/project',
  })
  assert.equal(parseRemote('not a url'), null)
  assert.equal(kindOf('github.com'), 'github')
  assert.equal(kindOf('gitlab.example.com'), 'gitlab')
  assert.equal(kindOf('codeberg.org'), null)
})

const render = async (md: string, kind: 'github' | 'gitlab' = 'github') =>
  (
    await renderMarkdown(md, {
      page: 'p',
      file: '',
      resolve: () => null,
      textLinks: forgeLinks({ kind, host: kind === 'github' ? 'github.com' : 'gitlab.example.com', repo: 'o/r' }),
    })
  ).html

test('forge: #n is an issue and !n a pull or merge request, here or in another repository', async () => {
  const gh = await render('Fixed in !34, closes #12, see a/b#3.')
  assert.match(gh, /<a href="https:\/\/github.com\/o\/r\/pull\/34" title="pull request o\/r!34">!34<\/a>/)
  assert.match(gh, /<a href="https:\/\/github.com\/o\/r\/issues\/12" title="issue o\/r#12">#12<\/a>/)
  assert.match(gh, /<a href="https:\/\/github.com\/a\/b\/issues\/3"[^>]*>a\/b#3<\/a>/)
  const gl = await render('!34 and #12', 'gitlab')
  assert.match(gl, /href="https:\/\/gitlab.example.com\/o\/r\/-\/merge_requests\/34"/)
  assert.match(gl, /href="https:\/\/gitlab.example.com\/o\/r\/-\/issues\/12"/)
})

test('forge: not in code, links or inline directives, nor glued to a word', async () => {
  const html = await render(
    '`#12` and [see #13](https://x.test) and C#1 and x!3 and file.md#14 and :button[Do #15]{name=go}\n\n```\n#16\n```',
  )
  assert.doesNotMatch(html, /issues\/1[2-6]|pull\/3|issues\/1"/)
})
