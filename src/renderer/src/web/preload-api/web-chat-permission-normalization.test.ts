import { expect, it } from 'vitest'
import { runtimeChatPermissionSetting } from './web-preference-normalization'

it('keeps the legacy host-support marker without recreating per-agent chat copies', () => {
  expect(runtimeChatPermissionSetting({ nativeChatPermissionMode: 'ask' })).toEqual({
    nativeChatPermissionMode: 'ask'
  })
  expect(runtimeChatPermissionSetting({})).toEqual({})
})
