import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { AgentLaunchSettingsMutation } from '../../../../shared/agent-launch-settings'
import {
  applyAllAgentsPermission,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionSettings
} from '../../../../shared/tui-agent-permission-choice'

export function agentPermissionResetNotice(
  settings: AgentPermissionSettings | null,
  mutation: AgentLaunchSettingsMutation
): () => void {
  if (
    !settings ||
    mutation.type !== 'permission' ||
    mutation.agent ||
    mutation.withoutAuto ||
    mutation.choice === 'default'
  ) {
    return () => {}
  }
  const previous = settings.agentPermissionOverrides ?? {}
  const next = applyAllAgentsPermission(settings, mutation.choice)
  const labels = PERMISSION_CHOICE_AGENTS.filter(
    (agent) =>
      previous[agent] !== undefined &&
      previous[agent] !== resolveAgentPermission(agent, next).choice
  ).map(getAgentLabel)
  return () => {
    if (labels.length === 1) {
      toast.success(
        translate(
          'settings.agents.permissionResetSingle',
          "{{agent}}'s separate permission was reset.",
          { agent: labels[0] }
        )
      )
    } else if (labels.length > 1) {
      const names =
        labels.length <= 3
          ? labels
          : [
              ...labels.slice(0, 2),
              translate('settings.agents.permissionResetOthers', '{{count}} other agents', {
                count: labels.length - 2
              })
            ]
      toast.success(
        translate(
          'settings.agents.permissionResetMany',
          'Separate permissions were reset for {{agents}}.',
          {
            agents: new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(names)
          }
        )
      )
    }
  }
}
