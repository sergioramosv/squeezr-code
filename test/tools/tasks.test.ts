import { describe, it, expect, beforeEach } from 'vitest'
import {
  taskCreate, taskList, taskGet, taskUpdate, taskSnapshot,
  clearAllTasks, taskRehydrate, taskClear,
} from '../../src/tools/tasks.js'

describe('tasks', () => {
  beforeEach(() => taskClear())

  describe('taskCreate', () => {
    it('errors when subject missing', () => {
      expect(taskCreate({})).toBe('Error: subject is required')
    })

    it('creates task with subject', () => {
      const out = taskCreate({ subject: 'Write tests' })
      expect(out).toContain('Task #1 created')
      expect(out).toContain('Write tests')
    })

    it('increments id per task', () => {
      taskCreate({ subject: 'A' })
      const out = taskCreate({ subject: 'B' })
      expect(out).toContain('#2')
    })

    it('stores description and activeForm', () => {
      taskCreate({ subject: 'X', description: 'why', activeForm: 'doing X' })
      const snap = taskSnapshot()
      expect(snap[0].description).toBe('why')
      expect(snap[0].activeForm).toBe('doing X')
    })
  })

  describe('taskList', () => {
    it('shows "No tasks yet" when empty', () => {
      expect(taskList()).toBe('No tasks yet.')
    })

    it('lists tasks with status icons', () => {
      taskCreate({ subject: 'A' })
      taskCreate({ subject: 'B' })
      const out = taskList()
      expect(out).toContain('#1')
      expect(out).toContain('A')
      expect(out).toContain('#2')
      expect(out).toContain('B')
      expect(out).toContain('○')
    })

    it('shows ⋯ for in_progress tasks', () => {
      taskCreate({ subject: 'X' })
      taskUpdate({ taskId: '1', status: 'in_progress' })
      expect(taskList()).toContain('⋯')
    })

    it('shows ✓ for completed tasks', () => {
      taskCreate({ subject: 'X' })
      taskUpdate({ taskId: '1', status: 'completed' })
      expect(taskList()).toContain('✓')
    })

    it('shows blocked-by hint', () => {
      taskCreate({ subject: 'X' })
      taskUpdate({ taskId: '1', addBlockedBy: ['2'] })
      expect(taskList()).toContain('blocked by: 2')
    })
  })

  describe('taskGet', () => {
    it('errors when not found', () => {
      expect(taskGet({ taskId: '999' })).toContain('not found')
    })

    it('returns JSON with key fields', () => {
      taskCreate({ subject: 'X' })
      const out = JSON.parse(taskGet({ taskId: '1' }))
      expect(out.id).toBe('1')
      expect(out.subject).toBe('X')
      expect(out.status).toBe('pending')
    })
  })

  describe('taskUpdate', () => {
    beforeEach(() => { taskCreate({ subject: 'X' }) })

    it('errors when not found', () => {
      expect(taskUpdate({ taskId: '999', status: 'in_progress' })).toContain('not found')
    })

    it('updates status', () => {
      const out = taskUpdate({ taskId: '1', status: 'completed' })
      expect(out).toContain('completed')
    })

    it('updates subject', () => {
      taskUpdate({ taskId: '1', subject: 'Y' })
      expect(taskSnapshot()[0].subject).toBe('Y')
    })

    it('handles status=deleted by removing the task', () => {
      const out = taskUpdate({ taskId: '1', status: 'deleted' })
      expect(out).toContain('deleted')
      expect(taskSnapshot().length).toBe(0)
    })

    it('addBlockedBy dedupes', () => {
      taskUpdate({ taskId: '1', addBlockedBy: ['2', '2', '3'] })
      const t = taskSnapshot()[0]
      expect(t.blockedBy).toEqual(['2', '3'])
    })

    it('addBlocks dedupes', () => {
      taskUpdate({ taskId: '1', addBlocks: ['5', '5'] })
      expect(taskSnapshot()[0].blocks).toEqual(['5'])
    })
  })

  describe('taskSnapshot + taskRehydrate', () => {
    it('snapshot/rehydrate round-trip preserves tasks', () => {
      taskCreate({ subject: 'A' })
      taskCreate({ subject: 'B' })
      const snap = taskSnapshot()
      taskClear()
      expect(taskSnapshot().length).toBe(0)
      taskRehydrate(snap)
      expect(taskSnapshot().length).toBe(2)
    })

    it('rehydrate sets nextId past the max', () => {
      taskRehydrate([{ id: '7', subject: 'X', status: 'pending', createdAt: 0, updatedAt: 0 }])
      const out = taskCreate({ subject: 'next' })
      expect(out).toContain('#8')
    })
  })

  describe('clearAllTasks', () => {
    it('removes all tasks', () => {
      taskCreate({ subject: 'A' })
      taskCreate({ subject: 'B' })
      clearAllTasks()
      expect(taskSnapshot().length).toBe(0)
    })
  })
})
