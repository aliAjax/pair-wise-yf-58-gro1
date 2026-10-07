import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Mock ant-design-vue message so it doesn't try to render Vue components in jsdom.
const messageCalls: string[] = [];
vi.mock('ant-design-vue', () => ({
  message: {
    error: (m: string) => messageCalls.push(m),
    warning: (m: string) => messageCalls.push(m),
    success: () => {},
    info: () => {}
  }
}));

import { useFlagStore } from '../src/stores/flags';

beforeEach(() => {
  localStorage.clear();
  messageCalls.length = 0;
  setActivePinia(createPinia());
});

describe('data migration', () => {
  it('fills version/rulesVersion and converts legacy string approvals', () => {
    localStorage.setItem('yf58-flag-state', JSON.stringify({
      activeId: 'x1',
      flags: [{ id: 'x1', name: '旧开关', key: 'legacy', enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft' }],
      plans: [{ id: 'px1', flagId: 'x1', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 2 }],
      audit: [{ id: 'a1', at: '09:00', actor: '产品负责人', action: '创建草稿', detail: '旧规则' }]
    }));
    const s = useFlagStore();
    expect(s.active?.version).toBe(1);
    expect(s.active?.rulesVersion).toBe(1);
    expect(s.activePlan?.approvals[0]).toEqual({ role: '产品负责人', version: 2, at: '' });
    expect(s.activePlan?.approvals[1]).toEqual({ role: '研发负责人', version: 2, at: '' });
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0].action).toBe('创建草稿');
    expect(s.active?.name).toBe('旧开关');
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale save and does not overwrite', () => {
    const tabA = useFlagStore();
    setActivePinia(createPinia());
    const tabB = useFlagStore();
    expect(tabA.active?.version).toBe(1);
    expect(tabB.active?.version).toBe(1);

    tabA.updateRule({ region: '北京' });
    expect(tabA.active?.version).toBe(2);
    expect(tabA.active?.rules.region).toBe('北京');

    // Tab B saves based on stale version 1.
    tabB.updateRule({ region: '广东' });
    expect(tabB.active?.rules.region).toBe('上海'); // unchanged
    expect(tabB.stale).toBe(true);
    expect(messageCalls.some((m) => m.includes('内容已变化'))).toBe(true);
    // Persisted state keeps tab A's value.
    const persisted = JSON.parse(localStorage.getItem('yf58-flag-state')!);
    expect(persisted.flags[0].rules.region).toBe('北京');
  });

  it('allows save after refresh', () => {
    const tabA = useFlagStore();
    setActivePinia(createPinia());
    const tabB = useFlagStore();
    tabA.updateRule({ region: '北京' });
    tabB.updateRule({ region: '广东' }); // rejected
    expect(tabB.stale).toBe(true);
    tabB.refresh();
    expect(tabB.stale).toBe(false);
    expect(tabB.active?.version).toBe(2);
    tabB.updateRule({ region: '广东' });
    expect(tabB.active?.rules.region).toBe('广东');
    expect(tabB.active?.version).toBe(3);
  });
});

describe('approval versioning', () => {
  it('records approvals on the approved rules version and invalidates on rule change', () => {
    const s = useFlagStore();
    expect(s.active?.rulesVersion).toBe(1);
    s.approve('产品负责人');
    s.approve('研发负责人');
    expect(s.currentApprovals).toHaveLength(2);
    expect(s.currentApprovals.every((a) => a.version === 1)).toBe(true);
    expect(s.active?.status).toBe('approved');

    s.updateRule({ region: '广东' });
    expect(s.active?.rulesVersion).toBe(2);
    expect(s.currentApprovals).toHaveLength(0);
    expect(s.active?.status).toBe('draft');
    expect(s.active?.enabled).toBe(false);

    s.approve('产品负责人');
    s.approve('研发负责人');
    expect(s.currentApprovals).toHaveLength(2);
    expect(s.currentApprovals.every((a) => a.version === 2)).toBe(true);
    expect(s.active?.status).toBe('approved');
  });

  it('does not invalidate approvals on rollout change', () => {
    const s = useFlagStore();
    s.approve('产品负责人');
    s.approve('研发负责人');
    s.setRollout(50);
    expect(s.active?.rollout).toBe(50);
    expect(s.currentApprovals).toHaveLength(2);
    expect(s.active?.status).toBe('approved');
  });
});

describe('reversion on config change', () => {
  it('reverts rolling to draft on rule change', () => {
    const s = useFlagStore();
    s.updateRule({ region: '上海' });
    s.approve('产品负责人');
    s.approve('研发负责人');
    s.startRollout();
    expect(s.active?.status).toBe('rolling');
    s.updateRule({ appVersion: '>= 9.0' });
    expect(s.active?.status).toBe('draft');
    expect(s.active?.enabled).toBe(false);
  });

  it('first schedule sets scheduled, schedule change reverts to draft', () => {
    const s = useFlagStore();
    s.schedule('2026-11-01T10:00');
    expect(s.active?.status).toBe('scheduled');
    s.schedule('2026-12-01T10:00');
    expect(s.active?.status).toBe('draft');
  });
});

describe('cross-tab storage event', () => {
  it('detects external modification and marks stale', () => {
    const s = useFlagStore();
    s.persist(); // ensure seed is written to localStorage
    s.initStorageListener();
    // Simulate another tab writing.
    const other = JSON.parse(localStorage.getItem('yf58-flag-state')!);
    other.flags[0].rules.region = '北京';
    other.flags[0].version = 99;
    localStorage.setItem('yf58-flag-state', JSON.stringify(other));
    window.dispatchEvent(new StorageEvent('storage', { key: 'yf58-flag-state', newValue: JSON.stringify(other) }));
    expect(s.stale).toBe(true);
    expect(s.active?.version).toBe(99);
    s.refresh();
    expect(s.stale).toBe(false);
    expect(s.editingVersion).toBe(99);
    s.destroyStorageListener();
  });
});
