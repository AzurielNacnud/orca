import { readFileSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('enforces five raw catalog forms with the actual config and narrow file exceptions', () => {
  const config = JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  expect(config.ignorePatterns.every((pattern) => typeof pattern === 'string')).toBe(true)
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sta-10541-catalog-rule-')))
  const source = `
    const key = 'projects';
    function read(state) {
      state.endpointProjects;
      state?.endpointProjectHostSetups;
      const { endpointProjects: projects } = state;
      state['endpointProjectHostSetups'];
      const key = 'endpointProjects'; state[key];
      { const key = 'projects'; state[key]; }
      function shadow(key) { return state[key]; }
      const unrelated = 'projectHostSetups'; state[unrelated];
      state.projects;
      state.projectHostSetups;
      return projects;
    }
  `
  try {
    writeFileSync(
      join(folder, 'config.json'),
      JSON.stringify({
        ...config,
        jsPlugins: config.jsPlugins.map((plugin) => ({
          ...plugin,
          specifier: resolve(plugin.specifier)
        }))
      })
    )
    const lint = (file, content = source) => {
      const target = join(folder, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      const result = spawnSync(
        resolve('node_modules/.bin/oxlint'),
        ['--config', join(folder, 'config.json'), '--format', 'json', file],
        { cwd: folder, encoding: 'utf8' }
      )
      expect(result.error).toBeUndefined()
      const diagnostics = JSON.parse(result.stdout).diagnostics
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout).number_of_files, result.stdout).toBe(1)
      return diagnostics.filter(
        (entry) =>
          entry.code.includes('no-restricted-properties') ||
          entry.code.includes('no-raw-project-catalog-computed')
      )
    }
    for (const file of [
      'src/renderer/src/hooks/useActiveProjectSkillRuntime.ts',
      'src/renderer/src/store/repos/repo-state.ts'
    ]) {
      const forbidden = lint(file)
      expect(forbidden).toHaveLength(5)
      expect(
        forbidden.filter((entry) => entry.code.includes('no-restricted-properties'))
      ).toHaveLength(4)
      expect(
        forbidden.filter((entry) => entry.code.includes('no-raw-project-catalog-computed'))
      ).toHaveLength(1)
    }
    const allowed = 'src/renderer/src/store/project-host-setup-selector.ts'
    expect(lint(allowed)).toEqual([])
    const uuid = lint(allowed, 'crypto.randomUUID()')
    expect(uuid).toHaveLength(1)
    expect(uuid[0].message).toContain('randomUUID')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
