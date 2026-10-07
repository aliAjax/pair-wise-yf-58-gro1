import { createPinia } from 'pinia';

// ---- 极简 localStorage 垫片（两个标签页共享同一份存储） ----
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
(globalThis as any).localStorage = new MemoryStorage();

const { useFlagStore, migrate } = await import('../src/stores/flags.ts');

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
}

/* ---------- 1. 旧数据迁移 ---------- */
const old = {
  flags: [
    { id: 'f1', name: '旧开关', key: 'old-flag', enabled: true, rollout: 50, rules: { region: '北京', appVersion: '>= 9.0', authenticated: true }, status: 'rolling' }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-08T09:00', approvals: ['产品负责人', '研发负责人'], version: 7 }
  ],
  audit: [
    { id: 'a1', at: '10:00', actor: '产品负责人', action: '创建草稿', detail: '老审计' }
  ]
};
const m = migrate(old);
check('迁移补齐 flag.version=1', m.flags[0].version === 1);
check('迁移补齐 updatedAt/updatedBy', m.flags[0].updatedAt === '' && m.flags[0].updatedBy === '历史数据');
check('旧 approvals:string[] 迁移为版本绑定对象', m.plans[0].approvals.length === 2 && m.plans[0].approvals[0].role === '产品负责人' && m.plans[0].approvals[0].version === 1 && m.plans[0].approvals[0].legacy === true);
check('旧 plan.version 迁移为 scheduleVersion=7', m.plans[0].scheduleVersion === 7);
check('旧审计照旧可读', m.audit.length === 1 && m.audit[0].detail === '老审计');

const oldEmpty = migrate({});
check('空/损坏旧数据安全兜底', oldEmpty.flags.length === 0 && Array.isArray(oldEmpty.plans) && Array.isArray(oldEmpty.audit));

// 以旧数据作为共享存储，模拟“打开时补齐版本信息”
localStorage.setItem('yf58-flag-state', JSON.stringify(old));

/* ---------- 2. 两个标签页并发保存 ---------- */
const piniaA = createPinia();
const piniaB = createPinia();
const tabA = useFlagStore(piniaA); // 产品负责人
const tabB = useFlagStore(piniaB); // 研发负责人
tabA.select('f1'); tabB.select('f1');

// 迁移后基准版本
const base = tabA.active!.version; // 1
check('两标签页读到同一基准版本', tabB.active!.version === base);

// 产品先改地区并保存 → v2
const rA = tabA.saveRules(base, { region: '上海', appVersion: '>= 9.0', authenticated: true }, '产品负责人');
check('产品负责人先保存成功，版本递增', rA.ok && tabA.active!.version === base + 1, `v${tabA.active!.version}`);

// 研发还基于旧版本 base，晚到保存 → 必须冲突，不能覆盖
const rB = tabB.saveRules(base, { region: '广东', appVersion: '>= 9.1', authenticated: false }, '研发负责人');
check('研发负责人晚保存被拒绝(conflict)', !rB.ok && (rB as any).reason === 'conflict' && (rB as any).currentVersion === base + 1);
check('晚到保存没有覆盖先保存的内容', tabA.active!.rules.region === '上海' && tabA.active!.rules.appVersion === '>= 9.0');

// 研发同步最新后基于 v2 重新保存 → v3 成功
tabB.syncFromStorage();
const base2 = tabB.active!.version;
const rB2 = tabB.saveRules(base2, { region: '广东', appVersion: '>= 9.1', authenticated: false }, '研发负责人');
check('同步后再保存成功', rB2.ok && tabB.active!.version === base2 + 1 && tabB.active!.rules.region === '广东');

/* ---------- 3. 审批绑定版本，版本改动后失效 ---------- */
const v3 = tabA; v3.syncFromStorage();
const curVersion = v3.active!.version; // 3
const ap1 = v3.approve(curVersion, '产品负责人');
const ap2 = v3.approve(curVersion, '研发负责人');
check('双审批落在当前版本', ap1.ok && ap2.ok && v3.effectiveApprovals('f1').length === 2);
check('审批后状态 approved', v3.active!.status === 'approved');

// 基于旧版本审批 → 冲突拒绝
const stale = tabB; // tabB 视图仍可能停留旧；强制构造旧基线
const oldBaseApprove = v3.approve(curVersion - 1, '不存在角色');
check('基于旧版本的审批被拒绝', !oldBaseApprove.ok);

// 新版本内容改动 → 审批失效
const v4res = v3.saveRules(curVersion, { region: '广东', appVersion: '>= 9.2', authenticated: false }, '产品负责人');
check('内容改动产生新版本', v4res.ok && v3.active!.version === curVersion + 1);
check('原审批在新版本上失效', v3.effectiveApprovals('f1').length === 0);
const plan = v3.planFor('f1')!;
check('旧审批记录仍保留备查（含版本号）', plan.approvals.filter(a => a.version === curVersion).length === 2 && plan.approvals.length >= 2, `共 ${plan.approvals.length} 条`);
check('状态回到 draft', v3.active!.status === 'draft');

/* ---------- 4. 定时生效与进行中放量在版本改动后退回 ---------- */
v3.saveSchedule(v3.active!.version, '2026-10-09T10:00', '产品负责人');
check('定时挂接当前版本', v3.planFor('f1')!.scheduleVersion === v3.active!.version);
v3.approve(v3.active!.version, '产品负责人');
v3.approve(v3.active!.version, '研发负责人');
v3.startRollout(v3.active!.version);
check('开始灰度: rolling + enabled', v3.active!.status === 'rolling' && v3.active!.enabled === true);

// 另一个标签页在放量中改规则（同步后基于当前版本）
tabB.syncFromStorage();
const rollingVersion = tabB.active!.version;
const stopRes = tabB.saveRules(rollingVersion, { region: '北京', appVersion: '>= 9.3', authenticated: true }, '研发负责人');
check('放量中的规则改动保存成功', stopRes.ok);
tabA.syncFromStorage();
check('版本改动后放量被退回: enabled=false, draft', tabA.active!.enabled === false && tabA.active!.status === 'draft', tabA.active!.status);
check('定时挂接摘除(scheduleVersion=null)', tabA.planFor('f1')!.scheduleVersion === null);
check('定时时间保留可读，标记为需重新确认', tabA.planFor('f1')!.scheduledAt === '2026-10-09T10:00');
check('放量退回后审批也需重新补齐', tabA.effectiveApprovals('f1').length === 0);

/* ---------- 5. 紧急停止始终可用（不走版本锁） ---------- */
tabA.emergencyStop();
check('紧急停止立即生效', tabA.active!.status === 'stopped' && tabA.active!.enabled === false);

/* ---------- 6. 放量配置并发也走版本检查 ---------- */
const pA = createPinia(); const pB = createPinia();
localStorage.clear();
const tA = useFlagStore(pA), tB = useFlagStore(pB);
const seedVersion = tA.active!.version;
const ok1 = tA.saveRollout(seedVersion, 80, '产品负责人');
const conflict1 = tB.saveRollout(seedVersion, 20, '研发负责人');
check('放量并发: 先到成功', ok1.ok);
check('放量并发: 晚到冲突拒绝，不覆盖80%', !conflict1.ok && tA.active!.rollout === 80, `rollout=${tA.active!.rollout}`);

/* ---------- 7. 无变化保存不产生新版本；落后标签页即使内容巧合相同也冲突 ---------- */
const pC = createPinia();
localStorage.clear();
const tC = useFlagStore(pC);
tC.select('f1');
const v0 = tC.active!.version;
const noChange = tC.saveRules(v0, { ...tC.active!.rules }, '产品负责人');
const noChangeRollout = tC.saveRollout(v0, tC.active!.rollout, '产品负责人');
check('内容相同的保存不递增版本', noChange.ok && noChangeRollout.ok && tC.active!.version === v0, `v${tC.active!.version}`);

const pD = createPinia();
const tD = useFlagStore(pD);
const baseD = tD.active!.version;
tC.saveRollout(baseD, 80, '产品负责人'); // C 先保存 → 新版本
const sameButStale = tD.saveRollout(baseD, 10, '研发负责人'); // D 提交的恰好是旧值
check('落后标签页即使提交值相同仍冲突，不静默成功', !sameButStale.ok && (sameButStale as any).currentVersion === baseD + 1);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
