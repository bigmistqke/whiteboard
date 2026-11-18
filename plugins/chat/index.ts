// :::chat{name=…} — a chat between the reader and the agent, anywhere on a page; and the chat under
// every form, which the form plugin places with the form's name. See README.md.
//
// A message is a `chat:message` event, `{ chat, text }`, from the reader (the page) or the agent
// (`whiteboard append`); the chat's name says which chat it belongs to. Messages are never answers:
// a form's chat is talk about the question, never a choice.
import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, raw, type Block, type DirectiveContext } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'
import { isQuestionName } from '../../src/status.ts'

const style = 'style.css'

/**
 * What the chat needs to know. `form`: the form it sits under, if any, with the names of its choices,
 * whose values are never a remark (a message can answer text the reader typed into a submit).
 */
export interface ChatProps { chat: string; form: string | null; choices: string[] }

/** The chat itself: a client island, so the server renders nothing for it. */
const thread: Block<ChatProps> = {
  style,
  props: ctx => ({
    chat: (ctx as DirectiveContext).attrs.chat ?? '',
    form: (ctx as DirectiveContext).attrs.form || null,
    choices: ((ctx as DirectiveContext).attrs.choices ?? '').split(' ').filter(Boolean),
  }),
  html: () => '',
  client: 'client.js',
}

const quote = (s: string) => s.replace(/"/g, '&quot;')

/** The chat thread for `chat`, as markup: for the chat block, and for the form plugin under a form. */
export const chatThread = (c: DirectiveContext, chat: string, form?: { choices: string[] }) =>
  c.markdown(`::chat-thread{chat="${quote(chat)}"${form ? ` form="${quote(chat)}" choices="${form.choices.join(' ')}"` : ''}}`)

/** `:::chat{name=…}`: a chat on its own, after whatever the block says above it. */
const chat: Block = {
  style,
  async html(ctx) {
    const c = ctx as DirectiveContext
    const name = c.attrs.name || c.attrs.id || 'chat'
    // a chat's name shares the forms' names: a colon marks events, never a chat
    if (!isQuestionName(name)) throw new Error(`chat name "${name}" has a colon: those names are reserved for events of whiteboard and plugins`)
    const body = c.children.length ? await c.toHtml(c.children) : ''
    return html`<section class="wb-chat-block" data-chat="${name}">${raw(body)}${raw(await chatThread(c, name))}</section>`
  },
}

export default function chatPlugin(): Plugin {
  return definePlugin({
    name: 'chat',
    public: builtinPublic('chat'),
    blocks: { chat, 'chat-thread': thread },
    events: {
      'chat:message': { handOut: true, forReader: true, description: 'a message in a chat: `{ chat, text }`, and `replaces` or `replyTo` (see below)' },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
