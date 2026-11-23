Steps in order down a line, a dot per step: what was done and what it showed.
Each step has room for full sentences, unlike a diagram's boxes.

A heading starts a step, titled by it: the shallowest headings in the block are
its steps, whatever their level. Deeper headings are the step's own and stay
headings in its body ("What it does", "Result"). A step's body is any markdown,
blocks too: a takeaway that should stand out can be a `:::callout` (the
timeline around it then takes four colons, `::::timeline`). A `---` starts an
untitled step. A badge ending a step's heading sits at its right. A
`:when[2026-11-21 10:43]` in a step's heading is when it happened: shown above
the title, as written.

**Sub steps.** A timeline inside a step is that step's sub steps: drawn a level
in, on a thinner line, and a timeline inside one of those again a level
further, to any depth. The outer timeline then needs more colons than the inner
one (`::::timeline` around `:::timeline`). That is also how steps are grouped:
a step for the group, its steps in a timeline inside it.

````markdown
::::timeline[Steps so far]
### :when[2026-11-21 10:43] Made a minimal repro :badge[done]
A chain of 6,400 closures overflows the stack: the crash is the chain, not
Solid.

### Counted the visits
5,150 visits for 100 links: each link walks the whole chain again.

:::timeline
### With the probe off
#### What it does
Runs the same chain with the probe switched off.

#### Result
The same 5,150: the probe isn't what walks it.

### With the cache on
100 visits: one per link.
:::
::::
````
