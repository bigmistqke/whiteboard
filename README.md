# visualize

Markdown pages for working with agents: they write `.md` files, you read them
as live HTML. Forms on a page write your answers to an ndjson log agents wait
on. See [DESIGN.md](DESIGN.md) for how it fits together.

```sh
npm install
npm link -w packages/engine      # puts `visualize` on the PATH
```

In a repository:

```sh
visualize init                   # .visualize/config.ts and .visualize/pages/
visualize show plan              # starts this project's server, prints http://localhost:4777/plan
```

Templates are imported in `.visualize/config.ts`:

```ts
import { defineConfig } from '@visualize/engine/config'
import basic from '@visualize/templates-basic'

export default defineConfig({ name: 'my-project', templates: [basic()] })
```

`@visualize/templates-basic` is not published yet; outside this repository
install it from the folder: `npm i -D /path/to/visualize/packages/templates-basic`.

The agent instructions are in [skills/visualize/SKILL.md](skills/visualize/SKILL.md);
link the folder into `~/.claude/skills/` to give every session the skill.
Template syntax: `visualize docs`, or `/_/docs` in the browser.

Each project runs its own server, and everything it keeps is in
`.visualize/`; nothing is written outside the project.
