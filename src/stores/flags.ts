import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';

export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }

export interface FeatureFlag {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  rollout: number;
  rules: RuleSet;
  status: FlagStatus;
  /** 规则/放量配置的内容版本，每次保存递增，作为乐观锁令牌 */
  version: number;
  /** 最近一次内容保存的时间，用于冲突提示 */
  updatedAt: string;
  /** 最近一次内容保存人 */
  updatedBy: string;
}

/** 审批记录固定在它批准的那一个内容版本上 */
export interface Approval { role: string; version: number; at: string; legacy?: boolean; }

export interface RolloutPlan {
  id: string;
  flagId: string;
  scheduledAt: string;
  approvals: Approval[];
  /** 定时生效所挂接的内容版本；与当前版本不一致即视为挂接失效，需重新确认 */
  scheduleVersion: number | null;
}

export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

interface State { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; }

/** 保存结果：ok 表示已落库；conflict 表示该标签页基于旧版本编辑，本次保存被拒绝 */
export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; currentVersion: number; updatedBy: string; updatedAt: string };

const STORAGE_KEY = 'yf58-flag-state';

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft', version: 3, updatedAt: '09:10', updatedBy: '产品负责人' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling', version: 5, updatedAt: '08:40', updatedBy: '研发负责人' }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', scheduleVersion: null, approvals: [] },
    { id: 'p2', flagId: 'f2', scheduledAt: '', scheduleVersion: 5, approvals: [
      { role: '产品负责人', version: 5, at: '08:31' },
      { role: '研发负责人', version: 5, at: '08:35' }
    ] }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ]
};

/* ---------------------------------- 迁移 ---------------------------------- */

/**
 * 打开旧数据时补齐版本信息：
 * - flag.version / updatedAt / updatedBy 缺省补齐；
 * - 旧的 approvals: string[] 迁移为绑定当前版本的审批（标记 legacy，照旧可读）；
 * - 旧 plan.version（原“计划版本”，语义上即其内容版本）迁移为 scheduleVersion；
 * - 审计记录字段缺失时兜底，草稿/审批/审计旧数据一律照旧可读。
 */
export function migrate(raw: unknown): State {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Partial<State>;
  const flags = Array.isArray(saved.flags) ? saved.flags : [];
  const plans = Array.isArray(saved.plans) ? saved.plans : [];
  const audit = Array.isArray(saved.audit) ? saved.audit : [];

  const migratedFlags: FeatureFlag[] = flags.map((flag) => {
    const f = flag as Partial<FeatureFlag>;
    return {
      id: String(f.id ?? ''),
      name: String(f.name ?? ''),
      key: String(f.key ?? ''),
      enabled: Boolean(f.enabled),
      rollout: Number(f.rollout ?? 0),
      rules: f.rules ?? { region: '全部', appVersion: '>= 1.0', authenticated: false },
      status: (f.status ?? 'draft') as FlagStatus,
      version: Math.max(1, Number(f.version ?? 1)),
      updatedAt: String(f.updatedAt ?? ''),
      updatedBy: String(f.updatedBy ?? '历史数据')
    };
  });

  const migratedPlans: RolloutPlan[] = plans.map((plan, index) => {
    const p = plan as Partial<RolloutPlan> & { approvals?: unknown; version?: number };
    const flagId = String(p.flagId ?? '');
    const flagVersion = migratedFlags.find((flag) => flag.id === flagId)?.version;
    const legacyVersion = flagVersion ?? Math.max(1, Number(p.version ?? 1));

    let approvals: Approval[];
    if (Array.isArray(p.approvals)) {
      approvals = p.approvals.map((entry) =>
        typeof entry === 'string'
          // 旧数据只有角色字符串：挂到迁移基准版本上，标记为历史审批，只读可查
          ? { role: entry, version: legacyVersion, at: '', legacy: true }
          : {
              role: String((entry as Approval).role ?? ''),
              version: Number((entry as Approval).version ?? legacyVersion),
              at: String((entry as Approval).at ?? ''),
              legacy: Boolean((entry as Approval).legacy)
            }
      );
    } else {
      approvals = [];
    }

    return {
      id: String(p.id ?? `p-migrated-${index}`),
      flagId,
      scheduledAt: String(p.scheduledAt ?? ''),
      approvals,
      scheduleVersion: p.scheduleVersion === undefined
        ? (p.version === undefined ? null : Number(p.version))
        : (p.scheduleVersion === null ? null : Number(p.scheduleVersion))
    };
  });

  const migratedAudit: AuditRecord[] = audit.map((entry, index) => {
    const a = (entry ?? {}) as Partial<AuditRecord>;
    return {
      id: String(a.id ?? `a-migrated-${index}`),
      at: String(a.at ?? ''),
      actor: String(a.actor ?? '历史操作人'),
      action: String(a.action ?? ''),
      detail: String(a.detail ?? '')
    };
  });

  const activeId = String(saved.activeId ?? migratedFlags[0]?.id ?? '');
  return { flags: migratedFlags, plans: migratedPlans, audit: migratedAudit, activeId };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return freshSeed();
  try { return migrate(JSON.parse(saved)); } catch { return freshSeed(); }
}

/** 读取另一个标签页刚刚落库的最新状态（冲突判定以共享存储为准） */
function readPersisted(): State | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return null;
  try { return migrate(JSON.parse(saved)); } catch { return null; }
}

/** 深拷贝：状态可能是响应式代理，structuredClone 无法处理，统一走 JSON 序列化 */
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function freshSeed(): State { return clone(seed); }

/* --------------------------------- Store ---------------------------------- */

export const useFlagStore = defineStore('flags', {
  state: (): State => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    planFor: (state) => (flagId: string): RolloutPlan | undefined => state.plans.find((item) => item.flagId === flagId)
  },
  actions: {
    persist() {
      // activeId 是每个标签页自己的浏览位置，不写入共享存储，避免跨标签页互相跳转
      const { flags, plans, audit } = this.$state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ flags, plans, audit }));
    },
    addAudit(action: string, detail: string, actor = '当前操作人') {
      this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toLocaleTimeString(), actor, action, detail });
    },
    select(id: string) { this.activeId = id; },

    /**
     * 带版本的保存核心：以 baseVersion 为乐观锁。
     * - 与共享存储中的最新版本不一致 → 返回 conflict，本次改动原样拒绝，不覆盖；
     * - bump=true 表示内容发生变化：版本 +1，旧审批失效，定时与进行中放量退回重新确认。
     */
    commit(flagId: string, baseVersion: number, actor: string, opts: { bump: boolean; apply: (flag: FeatureFlag, plan: RolloutPlan | undefined) => boolean | void; action: string; detail: string | ((flag: FeatureFlag) => string) }): SaveResult {
      const latest = readPersisted() ?? this.$state;
      const current = latest.flags.find((item) => item.id === flagId);
      if (!current) return { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      if (current.version !== baseVersion) {
        return { ok: false, reason: 'conflict', currentVersion: current.version, updatedBy: current.updatedBy, updatedAt: current.updatedAt };
      }

      // 以最新存储为准回灌，避免覆盖他人在本标签页之外的改动
      this.$patch({ flags: clone(latest.flags), plans: clone(latest.plans), audit: clone(latest.audit) });
      const flag = this.flags.find((item) => item.id === flagId);
      if (!flag) return { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      const plan = this.plans.find((item) => item.flagId === flagId);

      const changed = opts.apply(flag, plan) !== false;
      if (!changed) return { ok: true };

      if (opts.bump) {
        flag.version += 1;
        flag.updatedAt = new Date().toLocaleTimeString();
        flag.updatedBy = actor;
        // 内容版本变更：原审批全部失效（记录保留在 plan.approvals 中可审计，但不再有效）
        // 定时挂接摘除；正在进行的放量退回关闭，回到草稿等待重新确认
        if (plan) plan.scheduleVersion = null;
        if (flag.status === 'rolling' || flag.status === 'scheduled' || flag.status === 'approved') {
          flag.enabled = false;
          flag.status = 'draft';
        }
      }

      const detail = typeof opts.detail === 'function' ? opts.detail(flag) : opts.detail;
      this.addAudit(opts.action, detail, actor);
      this.persist();
      return { ok: true };
    },

    /** 保存规则组合（基于编辑时拿到的版本号，冲突则拒绝） */
    saveRules(baseVersion: number, rules: RuleSet, actor = '当前操作人'): SaveResult {
      return this.commit(this.activeId, baseVersion, actor, {
        bump: true,
        action: '修改规则',
        detail: (flag) => `${rules.region} / ${rules.appVersion} / 登录要求${rules.authenticated ? '是' : '否'}，保存为 v${flag.version}（原审批失效）`,
        apply: (flag) => {
          if (JSON.stringify(flag.rules) === JSON.stringify(rules)) return false;
          flag.rules = { ...rules };
          return true;
        }
      });
    },

    /** 保存放量配置（目标放量变化即内容变更，旧审批失效） */
    saveRollout(baseVersion: number, rollout: number, actor = '当前操作人'): SaveResult {
      let before = 0;
      return this.commit(this.activeId, baseVersion, actor, {
        bump: true,
        action: '调整放量',
        detail: (flag) => `${flag.key} 放量 ${before}% → ${rollout}%，保存为 v${flag.version}，原审批失效需重新确认`,
        apply: (flag) => {
          if (flag.rollout === rollout) return false;
          before = flag.rollout;
          flag.rollout = rollout;
          return true;
        }
      });
    },

    /** 保存/挂接定时生效时间：时间仍保留，但只有版本匹配时定时才处于挂接状态 */
    saveSchedule(baseVersion: number, scheduledAt: string, actor = '当前操作人'): SaveResult {
      return this.commit(this.activeId, baseVersion, actor, {
        bump: false,
        action: '设置定时',
        detail: `${this.active?.key ?? this.activeId} 于 ${scheduledAt} 生效（挂接当前版本 v${baseVersion}）`,
        apply: (flag, plan) => {
          if (!plan) return false;
          // 时间没变且已挂接当前版本才算无变化；重新挂接摘钩的定时是有意义的操作
          if (plan.scheduledAt === scheduledAt && plan.scheduleVersion === flag.version) return false;
          plan.scheduledAt = scheduledAt;
          plan.scheduleVersion = flag.version;
          if (flag.status !== 'rolling') flag.status = 'scheduled';
          return true;
        }
      });
    },

    /** 当前版本上的有效审批（审批固定在它批准的那一版，版本一变即失效） */
    effectiveApprovals(flagId: string): Approval[] {
      const flag = this.flags.find((item) => item.id === flagId);
      const plan = this.plans.find((item) => item.flagId === flagId);
      if (!flag || !plan) return [];
      return plan.approvals.filter((entry) => entry.version === flag.version);
    },

    /** 审批发布：审批记录落在当前内容版本上；基于旧版本操作时给出冲突提示 */
    approve(baseVersion: number, role: string): SaveResult {
      const flagId = this.activeId;
      const latest = readPersisted() ?? this.$state;
      const current = latest.flags.find((item) => item.id === flagId);
      if (!current || current.version !== baseVersion) {
        return current
          ? { ok: false, reason: 'conflict', currentVersion: current.version, updatedBy: current.updatedBy, updatedAt: current.updatedAt }
          : { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      }
      this.$patch({ flags: clone(latest.flags), plans: clone(latest.plans), audit: clone(latest.audit) });
      const plan = this.plans.find((item) => item.flagId === flagId);
      const flag = this.flags.find((item) => item.id === flagId);
      if (!plan || !flag) return { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      if (!plan.approvals.some((entry) => entry.version === flag.version && entry.role === role)) {
        plan.approvals.push({ role, version: flag.version, at: new Date().toLocaleTimeString() });
        const effective = plan.approvals.filter((entry) => entry.version === flag.version);
        if (effective.length >= 2 && plan.scheduleVersion === flag.version) flag.status = 'scheduled';
        else if (effective.length >= 2) flag.status = 'approved';
        this.addAudit('审批发布', `${role} 已确认 ${flag.key}（版本 v${flag.version}）`, role);
        this.persist();
      }
      return { ok: true };
    },

    /** 开始灰度：需要当前版本上双方审批齐备 */
    startRollout(baseVersion: number): SaveResult {
      const flagId = this.activeId;
      const latest = readPersisted() ?? this.$state;
      const current = latest.flags.find((item) => item.id === flagId);
      if (!current || current.version !== baseVersion) {
        return current
          ? { ok: false, reason: 'conflict', currentVersion: current.version, updatedBy: current.updatedBy, updatedAt: current.updatedAt }
          : { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      }
      this.$patch({ flags: clone(latest.flags), plans: clone(latest.plans), audit: clone(latest.audit) });
      const plan = this.plans.find((item) => item.flagId === flagId);
      const flag = this.flags.find((item) => item.id === flagId);
      if (!flag || !plan) return { ok: false, reason: 'conflict', currentVersion: baseVersion, updatedBy: '', updatedAt: '' };
      const effective = plan.approvals.filter((entry) => entry.version === flag.version);
      if (effective.length < 2) return { ok: false, reason: 'conflict', currentVersion: flag.version, updatedBy: flag.updatedBy, updatedAt: flag.updatedAt };
      flag.enabled = true;
      flag.status = 'rolling';
      this.addAudit('开始放量', `${flag.key} 按版本 v${flag.version} 启用 ${flag.rollout}%`);
      this.persist();
      return { ok: true };
    },

    /** 紧急停止：立即执行不走版本锁，任何时候都要能停下线上放量 */
    emergencyStop() {
      if (!this.active) return;
      const latest = readPersisted();
      if (latest) this.$patch({ flags: clone(latest.flags), plans: clone(latest.plans), audit: clone(latest.audit) });
      const flag = this.flags.find((item) => item.id === this.activeId);
      if (!flag) return;
      flag.enabled = false;
      flag.status = 'stopped';
      this.addAudit('紧急停止', `${flag.key} 已立即关闭（停止时版本 v${flag.version}）`);
      this.persist();
    },

    /** 回滚：关闭并清零放量 */
    rollback() {
      if (!this.active) return;
      const latest = readPersisted();
      if (latest) this.$patch({ flags: clone(latest.flags), plans: clone(latest.plans), audit: clone(latest.audit) });
      const flag = this.flags.find((item) => item.id === this.activeId);
      if (!flag) return;
      flag.enabled = false;
      flag.rollout = 0;
      flag.status = 'rolled-back';
      this.addAudit('执行回滚', `${flag.key} 回滚至关闭状态（回滚时版本 v${flag.version}）`);
      this.persist();
    },

    createFlag(name: string, key: string) {
      const id = `f-${Date.now()}`;
      const initialVersion = 1;
      this.flags.push({
        id, name, key, enabled: false, rollout: 0,
        rules: { region: '全部', appVersion: '>= 1.0', authenticated: false },
        status: 'draft', version: initialVersion,
        updatedAt: new Date().toLocaleTimeString(), updatedBy: '当前操作人'
      });
      this.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], scheduleVersion: null });
      this.activeId = id;
      this.addAudit('创建开关', `${key} 草稿版本 v${initialVersion}`);
      this.persist();
    },

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !this.active.enabled) return { hit: false, reason: '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < this.active.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${this.active.rollout}%` : `灰度桶 ${hash} ≥ ${this.active.rollout}%` };
    },

    /** 跨标签页同步：吸收另一个标签页的最新存储内容 */
    syncFromStorage(): { previousVersion?: number; currentVersion?: number } {
      const latest = readPersisted();
      if (!latest) return {};
      const flagId = this.activeId;
      const previousVersion = this.flags.find((item) => item.id === flagId)?.version;
      this.$patch({ flags: latest.flags, plans: latest.plans, audit: latest.audit });
      if (!this.flags.some((item) => item.id === this.activeId)) this.activeId = this.flags[0]?.id ?? '';
      const currentVersion = this.flags.find((item) => item.id === flagId)?.version;
      return { previousVersion, currentVersion };
    }
  }
});
