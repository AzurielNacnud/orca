import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { AgentLaunchSettingsMutation } from '../../../../shared/agent-launch-settings'
import {
  applyAllAgentsPermission,
  PERMISSION_CHOICE_AGENTS,
  type AgentPermissionSettings
} from '../../../../shared/tui-agent-permission-choice'
import { agentPermissionChoiceLabel } from './AgentPermissionChoiceControls'

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
  const choice = mutation.choice
  const previous = settings.agentPermissionOverrides ?? {}
  const next = applyAllAgentsPermission(settings, choice).agentPermissionOverrides
  const labels = PERMISSION_CHOICE_AGENTS.filter(
    (agent) => previous[agent] !== undefined && previous[agent] !== next[agent]
  ).map(getAgentLabel)
  return () => {
    if (labels.length) {
      toast.success(
        translate(
          'settings.agents.permissionResetNotice',
          '{{agents}}: separate permissions reset to {{mode}}.',
          { agents: labels.join(', '), mode: agentPermissionChoiceLabel(choice, null) }
        )
      )
    }
  }
}
