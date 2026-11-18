Issues and pull/merge requests of the project's GitHub or GitLab repository
link themselves: write `#12` for issue 12 and `!34` for pull or merge request
34, as plain text. `owner/repo#12` and `group/project!34` point into another
repository on the same host. Inside code (`` `#12` ``) they stay text.

The repository is read from the project's `origin` remote, so a self-hosted
GitLab works too. Without such a remote they stay text; a config can say
which: `forge({ repo: 'group/project', host: 'gitlab.example.com', kind: 'gitlab' })`.

```markdown
Fixed in !34, which closes #12 (see also bigmistqke/other#3).
```
