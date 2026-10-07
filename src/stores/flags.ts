import { defineStore } from 'pinia';
import { message } from 'ant-design-vue';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface Approval { role: string; version: number; at: string; }
export interface FeatureFlag {
  id: string; name: string; key: string; enabled: boolean; rollout: number;
  rules: RuleSet; status: FlagStatus;
  /** 乐观锁令牌：每次保存自增，用于检测并发覆盖 */
  version: number;
  /** 规则版本：仅在规则变更时自增，审批记在它批准的规则版本上 */
  rulesVersion: number;
}
export interface RolloutPlan {
  id: string; flagId: string; scheduledAt: string; approvals: Approval[];
}
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

interface PersistedState { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; }
interface State extends PersistedState {
  /** 当前编辑会话所基于的 version，用于乐观锁比对（不持久化） */
  editingVersion: number;
  /** 活动开关是否已被其他标签页改动（不持久化） */
  stale: boolean;
  /** storage 事件监听器句柄，用于卸载时清理（不持久化） */
  _storageHandler?: (e: StorageEvent) => void;
}

const STORAGE_KEY = 'yf58-flag-state';

const seed: PersistedState = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', version: 1, rulesVersion: 1 },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', version: 1, rulesVersion: 1 }
  ],
  plans: [{ id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [] }],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

/** 把任意历史数据迁移到当前结构：补齐 version / rulesVersion，把旧的字符串审批转成带版本的审批 */
function migrate(raw: unknown): PersistedState {
  const r = (raw ?? {}) as Partial<PersistedState> & { plans?: Array<Partial<RolloutPlan> & { approvals?: unknown; version?: number }> };
  const flags = Array.isArray(r.flags) ? r.flags as FeatureFlag[] : [];
  for (const f of flags) {
    if (typeof f.version !== 'number' || !Number.isFinite(f.version)) f.version = 1;
    if (typeof f.rulesVersion !== 'number' || !Number.isFinite(f.rulesVersion)) f.rulesVersion = f.version;
  }
  const plans = Array.isArray(r.plans) ? r.plans : [];
  for (const p of plans) {
    if (!Array.isArray(p.approvals)) { p.approvals = []; continue; }
    if (p.approvals.length > 0 && typeof p.approvals[0] === 'string') {
      const v = typeof p.version === 'number' && Number.isFinite(p.version) ? p.version : 1;
      p.approvals = (p.approvals as unknown as string[]).map((role) => ({ role, version: v, at: '' }));
    }
  }
  return {
    flags,
    plans: plans as RolloutPlan[],
    audit: Array.isArray(r.audit) ? r.audit as AuditRecord[] : [],
    activeId: typeof r.activeId === 'string' ? r.activeId : (flags[0]?.id ?? 'f1')
  };
}

function readState(): PersistedState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return migrate(JSON.parse(saved));
  } catch { /* 解析失败则回退到种子数据 */ }
  return structuredClone(seed);
}

export const useFlagStore = defineStore('flags', {
  state: (): State => ({ ...readState(), editingVersion: 1, stale: false, _storageHandler: undefined }),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    /** 当前规则版本下的有效审批 */
    currentApprovals(state): Approval[] {
      const flag = state.flags.find((item) => item.id === state.activeId);
      const plan = state.plans.find((item) => item.flagId === state.activeId);
      if (!flag || !plan) return [];
      return plan.approvals.filter((a) => a.version === flag.rulesVersion);
    }
  },
  actions: {
    persist() {
      const { flags, plans, audit, activeId } = this;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ flags, plans, audit, activeId }));
    },
    logAudit(action: string, detail: string, actor = '当前操作人') {
      this.audit.unshift({ id: `a-${Date.now()}`, at: new Date().toLocaleTimeString(), actor, action, detail });
      this.persist();
    },
    select(id: string) {
      this.activeId = id;
      const f = this.flags.find((item) => item.id === id);
      this.editingVersion = f ? f.version : 1;
      this.stale = false;
      this.persist();
    },
    create(name: string, key: string) {
      const id = `f-${Date.now()}`;
      this.flags.push({ id, name, key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft', version: 1, rulesVersion: 1 });
      this.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [] });
      this.select(id);
      this.logAudit('创建开关', `${key} 草稿版本 1`);
    },
    /**
     * 乐观锁提交：以持久化状态为基准，若活动开关的 version 与当前编辑基准不一致，
     * 说明已被其他标签页改动，拒绝覆盖并提示。成功则自增 version 并原子写入。
     */
    commit(
      mutator: (draft: PersistedState, flag: FeatureFlag, plan: RolloutPlan | undefined) => void,
      auditInfo?: { action: string; detail: string; actor?: string }
    ): { ok: boolean; conflict: boolean } {
      const latest = readState();
      const flag = latest.flags.find((item) => item.id === this.activeId);
      if (!flag) return { ok: false, conflict: false };
      if (flag.version !== this.editingVersion) {
        this.stale = true;
        message.error('内容已变化，无法覆盖，请刷新后重试');
        return { ok: false, conflict: true };
      }
      const draft = structuredClone(latest);
      const dFlag = draft.flags.find((item) => item.id === this.activeId)!;
      const dPlan = draft.plans.find((item) => item.flagId === this.activeId);
      mutator(draft, dFlag, dPlan);
      dFlag.version += 1;
      if (auditInfo) {
        draft.audit.unshift({
          id: `a-${Date.now()}`,
          at: new Date().toLocaleTimeString(),
          actor: auditInfo.actor ?? '当前操作人',
          action: auditInfo.action,
          detail: auditInfo.detail
        });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      this.flags = draft.flags;
      this.plans = draft.plans;
      this.audit = draft.audit;
      this.editingVersion = dFlag.version;
      this.stale = false;
      return { ok: true, conflict: false };
    },
    /** 从持久化状态重新载入，清除 stale 标记并重置编辑基准 */
    refresh() {
      const fresh = readState();
      this.flags = fresh.flags;
      this.plans = fresh.plans;
      this.audit = fresh.audit;
      if (!this.flags.some((f) => f.id === this.activeId)) {
        this.activeId = this.flags[0]?.id ?? 'f1';
      }
      const f = this.flags.find((item) => item.id === this.activeId);
      this.editingVersion = f ? f.version : 1;
      this.stale = false;
    },
    /** 监听其他标签页的写入：若活动开关已被改动，标记 stale 并提示刷新 */
    initStorageListener() {
      const handler = (e: StorageEvent) => {
        if (e.key !== STORAGE_KEY || !e.newValue) return;
        const fresh = readState();
        this.flags = fresh.flags;
        this.plans = fresh.plans;
        this.audit = fresh.audit;
        if (!this.flags.some((f) => f.id === this.activeId)) {
          this.activeId = this.flags[0]?.id ?? 'f1';
        }
        if (this.active && this.editingVersion !== this.active.version) {
          this.stale = true;
        }
      };
      window.addEventListener('storage', handler);
      this._storageHandler = handler;
    },
    destroyStorageListener() {
      if (this._storageHandler) {
        window.removeEventListener('storage', this._storageHandler);
        this._storageHandler = undefined;
      }
    },
    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      const detail = JSON.stringify(rule);
      const res = this.commit((_d, f, p) => {
        f.rules = { ...f.rules, ...rule };
        f.rulesVersion += 1;
        f.status = 'draft';
        f.enabled = false;
        if (p) p.approvals = [];
      }, { action: '修改规则', detail });
      if (res.conflict) return;
    },
    setRollout(value: number) {
      if (!this.active) return;
      const res = this.commit((_d, f) => { f.rollout = value; }, { action: '调整放量', detail: `${this.active.key} → ${value}%` });
      if (res.conflict) return;
    },
    schedule(value: string) {
      if (!this.active || !this.activePlan) return;
      const res = this.commit((_d, f, p) => {
        if (p) p.scheduledAt = value;
        // 已处于定时/放量状态时改时间，属于配置变更，退回草稿重新确认；首次设置则进入定时状态
        if (f.status === 'scheduled' || f.status === 'rolling') {
          f.status = 'draft';
          f.enabled = false;
          if (p) p.approvals = [];
        } else {
          f.status = 'scheduled';
        }
      }, { action: '设置定时', detail: `${this.active.key} 于 ${value} 生效` });
      if (res.conflict) return;
    },
    approve(role: string) {
      if (!this.active || !this.activePlan) return;
      if (this.currentApprovals.some((a) => a.role === role)) return;
      const res = this.commit((_d, f, p) => {
        if (!p) return;
        p.approvals.push({ role, version: f.rulesVersion, at: new Date().toISOString() });
        const current = p.approvals.filter((a) => a.version === f.rulesVersion);
        f.status = current.length >= 2 ? 'approved' : 'draft';
      }, { action: '审批发布', detail: `${role} 已确认 ${this.active.key}（规则 v${this.active.rulesVersion}）`, actor: role });
      if (res.conflict) return;
    },
    startRollout() {
      if (!this.active) return;
      if (this.currentApprovals.length < 2) { message.warning('当前规则版本尚未完成双审批'); return; }
      const res = this.commit((_d, f) => {
        f.enabled = true;
        f.status = 'rolling';
      }, { action: '开始放量', detail: `${this.active.key} 启用 ${this.active.rollout}%` });
      if (res.conflict) return;
    },
    emergencyStop() {
      if (!this.active) return;
      const res = this.commit((_d, f) => {
        f.enabled = false;
        f.status = 'stopped';
      }, { action: '紧急停止', detail: `${this.active.key} 已立即关闭` });
      if (res.conflict) return;
    },
    rollback() {
      if (!this.active) return;
      const res = this.commit((_d, f) => {
        f.enabled = false;
        f.rollout = 0;
        f.status = 'rolled-back';
      }, { action: '执行回滚', detail: `${this.active.key} 回滚至关闭状态` });
      if (res.conflict) return;
    },
    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !this.active.enabled) return { hit: false, reason: '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < this.active.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${this.active.rollout}%` : `灰度桶 ${hash} ≥ ${this.active.rollout}%` };
    }
  }
});
