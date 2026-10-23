// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'

it.each(['claimant', 'outclaimed', 'folder', 'remoteless'])(
  '%s preserves the approved host actions',
  async (kind) => {
    const repos: Repo[] = (kind === 'claimant' || kind === 'outclaimed' ? ['a', 'b'] : [kind]).map(
      (id, index) => ({
        id,
        path: `/${id}`,
        displayName: id,
        addedAt: index + 1,
        badgeColor: '',
        kind: kind === 'folder' ? 'folder' : 'git',
        ...(kind === 'claimant' || kind === 'outclaimed'
          ? { upstream: { owner: 'acme', repo: 'app' } }
          : {})
      })
    )
    const projection = projectHostSetupProjectionFromRepos(repos)
    const repo = repos[kind === 'outclaimed' ? 1 : 0]
    const projectId = projection.setups[kind === 'outclaimed' ? 1 : 0].projectId
    const createProjectHostSetup = vi.fn().mockResolvedValue(null)
    const existing = {
      ...projection.setups[0],
      id: 'pending',
      repoId: '',
      projectId,
      hostId: 'ssh:configured' as const,
      path: '',
      setupMethod: 'provisioned' as const,
      setupState: 'not-set-up' as const
    }
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos,
      projects: [...projection.projects],
      projectHostSetups: [...projection.setups, existing],
      sshTargetLabels: new Map([
        ['extra', 'extra'],
        ['configured', 'configured']
      ]),
      createProjectHostSetup
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const button = (label: string) =>
      Array.from(container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes(label)
      )
    const click = async (label: string) => {
      expect(button(label), label).toBeTruthy()
      expect(button(label)?.disabled).toBe(false)
      await act(async () => {
        button(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    try {
      await act(async () =>
        root.render(
          React.createElement(RepositoryHostSetupsSection, {
            repo,
            forceVisible: true,
            searchQuery: '',
            searchEntries: []
          })
        )
      )
      expect(container.textContent).toContain('configured')
      expect(container.textContent).toContain('Not set up')
      if (kind === 'outclaimed') {
        expect(button('Add to another host')).toBeUndefined()
        expect(createProjectHostSetup).not.toHaveBeenCalled()
      } else {
        await click('Add to another host')
        await click('Add host placeholder')
        await click('Add extra')
        expect(createProjectHostSetup).toHaveBeenCalledWith({
          projectId,
          hostId: 'ssh:extra',
          displayName: repo.displayName,
          setupState: 'not-set-up',
          setupMethod: 'provisioned'
        })
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
      useAppStore.setState(useAppStore.getInitialState(), true)
    }
  }
)
