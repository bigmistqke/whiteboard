What a program printed, as its terminal showed it: an `ansi` fence holds the
output with its escape codes, and the page draws it dark, in its colours, as a
terminal does. It goes through a terminal emulator on the server, so colours
(16, 256 and true colour, foreground and background), bold, dim and underline
show, and a progress line that a carriage return writes over shows as it
ended. It is plain HTML: nothing runs on the page, and `whiteboard build` keeps
it. Wide output scrolls sideways (a line wraps at 240 columns, as a terminal
that wide would).

````markdown
```ansi
\e[32m✔\e[0m parses a page
\e[31m✖\e[0m renders a diff \e[2m(12ms)\e[0m
```
````

```ansi
\e[32m✔\e[0m parses a page
\e[31m✖\e[0m renders a diff \e[2m(12ms)\e[0m
```

The escape byte itself works, and so does any way of writing it out: `\e`,
`\x1b`, `\033`, `\u001b` or `^[`. A carriage return has to be the byte itself,
as a program prints it: `\r` written out stays as written, since it is as
likely a path (`C:\repo`). To capture a command's colours, have it colour
output that isn't a terminal (`--color=always`, `FORCE_COLOR=1`) and paste
what it printed.

`title` puts it in a window with that label, whose button fills the browser
window with it:

````markdown
```ansi {title="npm test"}
…
```
````
