# whiteboard

A whiteboard for you and your agent. When something is too much for text in
a terminal, the agent writes a markdown page and you read it as live HTML.
Forms on the page write your answers to an ndjson log the agent waits on. See
[DESIGN.md](DESIGN.md) for how it fits together.

```sh
npm install
npm link                          # puts `whiteboard` on the PATH
```

In a repository:

```sh
whiteboard init                   # .whiteboard/config.ts and .whiteboard/pages/
whiteboard show plan              # starts this project's server, prints http://localhost:4777/plan
```

Templates are imported in `.whiteboard/config.ts`:

```ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import basic from '@bigmistqke/whiteboard/basic'

export default defineConfig({ name: 'my-project', templates: [basic()] })
```

The package `@bigmistqke/whiteboard` is not published yet. The server
resolves its imports itself, so a project's config can import it without
installing anything.

The agent instructions are in [skills/whiteboard/SKILL.md](skills/whiteboard/SKILL.md);
link the folder into `~/.claude/skills/` to give every session the skill.
Template syntax: `whiteboard docs`, or `/_/docs` in the browser.

Each project runs its own server, and everything it keeps is in
`.whiteboard/`; nothing is written outside the project.
