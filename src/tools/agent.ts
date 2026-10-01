/** Agent memory: /Agent notes, git-mirrored folders and skills. */

import { z } from 'zod'
import { READ, teamId, toolkit, type Register } from '../helpers.js'

export const register: Register = (server, client) => {
  const { tool } = toolkit(server)

  tool(
    'list_agent_notes',
    'List agent notes',
    'List Drive /Agent notes in a space (agent.md, learnings/letters.md, …) with their file ids; read one with read_file. Requires a content-access token.',
    { teamId },
    READ,
    (args) => client.listAgentNotes(args),
  )

  tool(
    'list_git_folders',
    'List git-mirrored folders',
    'List Drive folders that mirror a private git repo. Agents read the Drive copy — never ask for a GitHub token.',
    { teamId },
    READ,
    (args) => client.listGitFolders(args),
  )

  tool(
    'list_skills',
    'List skills',
    'List SKILL.md files mirrored from git folders in this space (e.g. novel-dialogue). Then read_file on the fileId.',
    { teamId },
    READ,
    (args) => client.listSkills(args),
  )

  tool(
    'read_skill',
    'Find a skill by name',
    'Find one mirrored skill by name (novel-dialogue) and return its Drive fileId. Use read_file next.',
    { name: z.string().describe('Skill name as listed by list_skills, e.g. "novel-dialogue".'), teamId },
    READ,
    ({ name, teamId }) => client.getSkill(name, { teamId }),
  )
}
