/** Tasks app: to-dos across personal and team spaces. */

import { z } from 'zod'
import { DESTRUCTIVE_IDEMPOTENT, READ, WRITE, WRITE_IDEMPOTENT, toolkit, type Register } from '../helpers.js'

const taskId = z.string().uuid().describe('Task UUID from list_tasks.')
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date YYYY-MM-DD. Resolve "tomorrow", "Friday" etc. against today yourself.')
const spaceId = z
  .string()
  .uuid()
  .nullable()
  .describe('Space (team) id from list_tasks → spaces[].id. null or omitted = Personal (only you see it).')

const fields = {
  notes: z.string().optional().describe('Longer description.'),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  dueDate: day.nullable().optional(),
  assigneeId: z
    .string()
    .nullable()
    .optional()
    .describe('User id of a member of the task\'s space (list_tasks → spaces[].members[].userId). Personal tasks: only you.'),
  waitingOn: z.string().optional().describe('Who or what the task waits for, e.g. "Sparkasse reply". Use with status waiting.'),
  followUpDate: day.nullable().optional().describe('When to chase a waiting task.'),
  listId: z.string().uuid().nullable().optional().describe('List in the same space (list_tasks → lists[].id).'),
  link: z
    .object({
      kind: z.enum(['file', 'folder', 'unit', 'building', 'scene', 'mail', 'crm', 'url']),
      label: z.string(),
      href: z.string().describe('In-app path like "/rentals/units/<id>" or an https URL.'),
      id: z.string().optional(),
    })
    .nullable()
    .optional()
    .describe('What the task is about; shown as a chip that opens it.'),
}

export const register: Register = (server, client) => {
  const { tool } = toolkit(server)

  tool(
    'list_tasks',
    'List tasks',
    'Tasks across Personal and every space the user is in, sorted by due date. Also returns lists, spaces with members (for assigneeId) and open Properties to-dos (read-only, under external). Use it to answer "what is due", "what is Kim working on", or before editing a task.',
    {
      space: z.string().optional().describe('"all" (default), "personal", or a space id.'),
      status: z.enum(['active', 'done', 'all']).optional().describe('active = open + waiting (default).'),
      assignee: z.string().optional().describe('"me" or a user id.'),
      listId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    READ,
    (args) => client.listTasks(args),
  )

  tool(
    'create_task',
    'Create a task',
    'Add a to-do. Keep the title short and actionable ("Call Sparkasse about Siegen loan"); put details in notes. Set spaceId for team tasks, dueDate when the user names a day.',
    { title: z.string().min(1).max(300), spaceId: spaceId.optional(), ...fields },
    WRITE,
    (args) => client.createTask(args),
  )

  tool(
    'update_task',
    'Update a task',
    'Change any field of a task: status (open, waiting, done — done records who and when), priority, due date, assignee, list, waiting on / follow-up, link, or move it to another space (spaceId; list and assignee are dropped if they do not belong there).',
    {
      taskId,
      title: z.string().min(1).max(300).optional(),
      status: z.enum(['open', 'waiting', 'done']).optional(),
      spaceId: spaceId.optional(),
      ...fields,
    },
    WRITE_IDEMPOTENT,
    ({ taskId: id, ...body }) => client.updateTask(id, body),
  )

  tool(
    'complete_task',
    'Complete a task',
    'Mark a task done (same as update_task with status done).',
    { taskId },
    WRITE_IDEMPOTENT,
    ({ taskId: id }) => client.updateTask(id, { status: 'done' }),
  )

  tool(
    'delete_task',
    'Delete a task',
    'Delete a task for good. Prefer complete_task for finished work; delete only mistakes or duplicates.',
    { taskId },
    DESTRUCTIVE_IDEMPOTENT,
    ({ taskId: id }) => client.deleteTask(id),
  )

  tool(
    'create_task_list',
    'Create a task list',
    'Create a list to group tasks in a space (e.g. a project or an episode).',
    { title: z.string().min(1).max(120), spaceId: spaceId.optional(), color: z.string().optional() },
    WRITE,
    (args) => client.createTaskList(args),
  )

  tool(
    'update_task_list',
    'Rename or archive a task list',
    'Rename a list, change its color, or archive it (archived lists are hidden from the main views; their tasks stay).',
    {
      listId: z.string().uuid(),
      title: z.string().min(1).max(120).optional(),
      color: z.string().optional(),
      archived: z.boolean().optional(),
    },
    WRITE_IDEMPOTENT,
    ({ listId, ...body }) => client.updateTaskList(listId, body),
  )
}
