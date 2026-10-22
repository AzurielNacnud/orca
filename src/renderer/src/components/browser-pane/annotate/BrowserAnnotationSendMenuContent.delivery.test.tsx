// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { BrowserAnnotationSendMenuContent } from './BrowserAnnotationSendMenuContent'

const harness = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  state: {
    activeWorktreeId: 'wt-1',
    activeTabType: 'browser' as const,
    activeTabId: 'browser-1',
    activeTabIdByWorktree: {},
    tabsByWorktree: { 'wt-1': new Array<TerminalTab>() },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty-1' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    runtimePaneTitlesByTabId: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    settings: { experimentalNativeChat: true },
    repos: [],
    worktreesByRepo: {}
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof harness.state) => unknown) => selector(harness.state),
    { getState: () => harness.state }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: harness.callRuntimeRpc }))
vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({ QuickLaunchAgentMenuItems: () => null }))
vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({ useWorktreeAgentRows: () => [] }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/structured-agent-session-launch-message', () => ({
  relaunchFailedStructuredAgentSessionWithMessage: vi.fn()
}))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  sendStructuredAgentSessionMessage: vi.fn()
}))

beforeEach(() => {
  vi.useFakeTimers()
  harness.callRuntimeRpc.mockReset()
  harness.state.tabsByWorktree = {
    'wt-1': [
      {
        id: 'tab-1',
        worktreeId: 'wt-1',
        ptyId: 'pty-1',
        title: '✳ Claude Code',
        launchAgent: 'claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderAnnotationSend(prompt: string, onPromptDelivered: () => void): void {
  render(
    <TooltipProvider>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Send</DropdownMenuTrigger>
        <DropdownMenuContent>
          <BrowserAnnotationSendMenuContent
            worktreeId="wt-1"
            groupId="wt-1"
            prompt={prompt}
            onPromptDelivered={onPromptDelivered}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

function connectTerminal(submitDelayMs?: number) {
  const writes: { text?: string; enter?: boolean }[] = []
  let permission = false
  let acknowledgePaste: () => void = () => {
    throw new Error('paste not started')
  }
  const pasteAccepted = new Promise<void>((resolve) => {
    acknowledgePaste = resolve
  })
  harness.callRuntimeRpc.mockImplementation(async (_target, method, params) => {
    if (method === 'terminal.list') {
      return {
        terminals: [
          {
            handle: 'term-1',
            tabId: 'tab-1',
            leafId: '11111111-1111-4111-8111-111111111111',
            connected: true,
            writable: true
          }
        ]
      }
    }
    if (method === 'terminal.agentStatus') {
      return {
        agentStatus: {
          handle: 'term-1',
          isRunningAgent: true,
          status: permission ? 'permission' : 'idle'
        }
      }
    }
    if (method === 'terminal.send') {
      writes.push(params)
      if (params.text) {
        await pasteAccepted
      }
      return {
        send: {
          handle: 'term-1',
          accepted: true,
          bytesWritten: params.text?.length ?? 1,
          ...(params.text && submitDelayMs !== undefined ? { submitDelayMs } : {})
        }
      }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  return {
    writes,
    acknowledgePaste,
    requirePermission: () => {
      permission = true
    }
  }
}

describe('browser annotation Send delivery', () => {
  it.each([true, false])(
    'pastes and auto-submits to Claude with native chat enabled = %s',
    async (nativeChat) => {
      harness.state.settings.experimentalNativeChat = nativeChat
      const { writes, acknowledgePaste } = connectTerminal(20_000)
      const delivered = vi.fn()
      const prompt = 'Browser feedback: 한글 button needs more padding.\n'.repeat(200)
      renderAnnotationSend(prompt, delivered)
      fireEvent.click(screen.getByRole('menuitem', { name: /Claude Code/ }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(writes).toHaveLength(1)
      expect(writes[0].text).toContain(prompt.trim())
      expect(writes[0].enter).toBeUndefined()
      expect(delivered).not.toHaveBeenCalled()
      acknowledgePaste()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(19_999)
      })
      expect(writes).toHaveLength(1)
      expect(delivered).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(writes).toHaveLength(2)
      expect(writes[1]).toMatchObject({ enter: true, requireAgentStatus: 'sendable' })
      expect(writes[1].text).toBeUndefined()
      expect(delivered).toHaveBeenCalledOnce()
    }
  )

  it('keeps the notes and withholds Enter if permission is requested during the host-calculated wait', async () => {
    const { writes, requirePermission, acknowledgePaste } = connectTerminal(1000)
    const delivered = vi.fn()
    renderAnnotationSend('Browser feedback', delivered)
    fireEvent.click(screen.getByRole('menuitem', { name: /Claude Code/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(writes).toHaveLength(1)
    acknowledgePaste()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    requirePermission()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(writes).toHaveLength(1)
    expect(delivered).not.toHaveBeenCalled()
  })

  it('keeps the 50 ms fallback for older hosts that omit the delay', async () => {
    const { writes, acknowledgePaste } = connectTerminal()
    const delivered = vi.fn()
    renderAnnotationSend('Browser feedback', delivered)
    fireEvent.click(screen.getByRole('menuitem', { name: /Claude Code/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    acknowledgePaste()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(49)
    })
    expect(writes).toHaveLength(1)
    expect(delivered).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(writes).toHaveLength(2)
    expect(writes[1].enter).toBe(true)
    expect(delivered).toHaveBeenCalledOnce()
  })
})
