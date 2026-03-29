import { loadCredentials } from '../../core/credential-manager'
import { Engine } from '../../types'

export type QuestLocalAuth = {
  user: string
  password: string
}

const QUEST_DEFAULT_USERNAME = 'admin'
const QUEST_DEFAULT_PASSWORD = 'quest'
const LEGACY_DEFAULT_USERNAME = 'spindb'

export async function loadLocalQuestAuth(
  containerName: string,
): Promise<QuestLocalAuth> {
  const primary = await loadCredentials(
    containerName,
    Engine.QuestDB,
    QUEST_DEFAULT_USERNAME,
  )
  if (primary) {
    return {
      user: primary.username,
      password: primary.password,
    }
  }

  const legacy = await loadCredentials(
    containerName,
    Engine.QuestDB,
    LEGACY_DEFAULT_USERNAME,
  )

  if (legacy) {
    return {
      user: legacy.username,
      password: legacy.password,
    }
  }

  return {
    user: QUEST_DEFAULT_USERNAME,
    password: QUEST_DEFAULT_PASSWORD,
  }
}
