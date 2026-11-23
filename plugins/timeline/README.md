Steps in order down a line, a dot per step: what was done, what it showed and
what it means. Each step has room for full sentences, unlike a diagram's boxes.

A heading starts a step, titled by it; its body is any markdown. A quote in a
step (`> …`) is **what the step means**, set apart under "So". With headings at
two levels, the shallower one groups the steps into sections. A `---` starts an
untitled step. A badge ending a step's heading sits at its right. A
`:when[2026-11-21 10:43]` in a step's heading is when it happened: shown above
the title, as written.

```markdown
:::timeline[Steps so far]
## Finding the cause

### :when[2026-11-21 10:43] Made a minimal repro :badge[done]
A chain of 6,400 closures overflows the stack.

> The crash is the chain, not Solid.

### Counted the visits
5,150 visits for 100 links.

> Each link walks the whole chain again.
:::
```
