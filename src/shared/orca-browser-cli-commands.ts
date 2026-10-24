import { COMMAND_TOKEN_SCAN_MAX_CHARS, getCommandTokenPathBasename } from './command-token-scanner'

/** The browser CLI's command keys per handler group. Kept apart from the CLI's
 *  lazy handler imports so the renderer and mobile can read them too. */
export const ORCA_BROWSER_CLI_COMMAND_KEYS = {
  'browser-identity': ['browser identity get', 'browser identity set'],
  'browser-nav': [
    'snapshot',
    'screenshot',
    'goto',
    'back',
    'reload',
    'forward',
    'eval',
    'scroll',
    'wait',
    'pdf',
    'full-screenshot'
  ],
  'browser-interact': [
    'click',
    'dblclick',
    'fill',
    'type',
    'select',
    'check',
    'uncheck',
    'focus',
    'clear',
    'select-all',
    'keypress',
    'hover',
    'drag',
    'upload',
    'scrollintoview',
    'get',
    'is',
    'inserttext',
    'mouse move',
    'mouse down',
    'mouse up',
    'mouse wheel',
    'find',
    'download',
    'highlight'
  ],
  'browser-tab': [
    'open-url',
    'tab list',
    'tab show',
    'tab current',
    'tab switch',
    'tab create',
    'tab close',
    'exec'
  ],
  'browser-profile': [
    'tab profile list',
    'tab profile create',
    'tab profile delete',
    'tab profile set',
    'tab profile show',
    'tab profile use-default',
    'tab profile clone'
  ],
  'browser-cookie': ['cookie get', 'cookie set', 'cookie delete'],
  'browser-capture': [
    'intercept enable',
    'intercept disable',
    'intercept list',
    'capture start',
    'capture stop',
    'console',
    'network'
  ],
  'browser-env': [
    'viewport',
    'geolocation',
    'set device',
    'set offline',
    'set headers',
    'set credentials',
    'set media',
    'clipboard read',
    'clipboard write',
    'dialog accept',
    'dialog dismiss'
  ],
  'browser-storage': [
    'storage local get',
    'storage local set',
    'storage local clear',
    'storage session get',
    'storage session set',
    'storage session clear'
  ]
} as const satisfies Record<string, readonly string[]>

const BROWSER_COMMAND_WORDS = new Set<string>(
  Object.values(ORCA_BROWSER_CLI_COMMAND_KEYS).flatMap((keys) =>
    keys.map((key) => key.split(' ')[0])
  )
)

// The published launcher names per platform, plus the dev build's.
const ORCA_CLI_BASENAME = /^orca(?:-dev|-ide)?(?:\.cmd|\.exe)?$/i
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export type OrcaBrowserCommand = { pageId: string | null }

/** The first `orca <browser command>` a shell command line runs, with the page it
 *  targets, or null when it runs none. Quoting inside a segment is not parsed. */
export function parseOrcaBrowserCommand(command: string): OrcaBrowserCommand | null {
  const scanned = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  for (const segment of scanned.split(SEGMENT_SEPARATOR)) {
    const tokens = segment.trim().split(/\s+/).map(unquote)
    let index = 0
    while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) {
      index += 1
    }
    const binary = tokens[index]
    const word = tokens[index + 1]
    if (
      binary !== undefined &&
      word !== undefined &&
      ORCA_CLI_BASENAME.test(getCommandTokenPathBasename(binary)) &&
      BROWSER_COMMAND_WORDS.has(word)
    ) {
      return { pageId: pageFlagValue(tokens.slice(index + 2)) }
    }
  }
  return null
}

function pageFlagValue(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--page') {
      return args[index + 1] || null
    }
    if (arg.startsWith('--page=')) {
      return unquote(arg.slice('--page='.length)) || null
    }
  }
  return null
}

function unquote(token: string): string {
  const quote = token[0]
  return token.length >= 2 && (quote === '"' || quote === "'") && token.at(-1) === quote
    ? token.slice(1, -1)
    : token
}
