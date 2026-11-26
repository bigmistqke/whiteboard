// The forge plugin on a served page: in a folder that is no git checkout (a job's folder, say), the
// config names the repository, and its issues and merge requests link, in headings too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { project } from './project.ts'

test('forge: a config names the repository of a folder without a remote', { timeout: 60000 }, async t => {
  const proj = await project({
    config: `import forge from '@bigmistqke/whiteboard/forge'\nexport default { plugins: [forge({ host: 'gitlab.com', repo: 'g/p' })] }\n`,
    pages: { p: '# Decisions\n\n## A form answer of its own (#4774)\n\nSee !12.\n' },
  })
  t.after(() => proj.close())
  const html = await (await fetch(proj.url('p'))).text()
  assert.doesNotMatch(html, /wb-error/)
  assert.match(
    html,
    /<h2>A form answer of its own \(<a href="https:\/\/gitlab.com\/g\/p\/-\/issues\/4774"[^>]*>#4774<\/a>\)<\/h2>/,
  )
  assert.match(html, /href="https:\/\/gitlab.com\/g\/p\/-\/merge_requests\/12"/)
})
