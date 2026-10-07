<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore, type RuleSet, type SaveResult } from './stores/flags';

const STORAGE_KEY = 'yf58-flag-state';
const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');

/* ----------------------- 编辑草稿与乐观锁基线版本 ----------------------- */
const draft = reactive<RuleSet>({ region: '全部', appVersion: '>= 1.0', authenticated: false });
/** 本标签页打开/同步时拿到的内容版本，保存时必须与服务端（共享存储）当前版本一致 */
const editingVersion = ref(0);
const rolloutDraft = ref(0);
const scheduleDraft = ref('');

interface ConflictInfo { scope: string; baseVersion: number; currentVersion: number; updatedBy: string; updatedAt: string; }
interface RemoteInfo { currentVersion: number; updatedBy: string; updatedAt: string; }
/** 晚到保存被拒绝的冲突提示 */
const conflict = ref<ConflictInfo | null>(null);
/** 另一个标签页先保存、且本页有未保存修改时的提示 */
const remoteNotice = ref<RemoteInfo | null>(null);

const rulesDirty = computed(() => !!active.value && JSON.stringify({ ...draft }) !== JSON.stringify(active.value.rules));
const rolloutDirty = computed(() => !!active.value && rolloutDraft.value !== active.value.rollout);
const scheduleDirty = computed(() => !!plan.value && scheduleDraft.value !== plan.value.scheduledAt);

const effectiveApprovals = computed(() => active.value ? store.effectiveApprovals(active.value.id) : []);
const staleApprovals = computed(() => {
  if (!plan.value || !active.value) return [];
  return plan.value.approvals.filter((entry) => entry.version !== active.value!.version);
});
const scheduleArmed = computed(() => !!plan.value && !!active.value && plan.value.scheduleVersion === active.value.version);

function adoptActive(force: boolean) {
  const flag = active.value;
  if (!flag) return;
  if (force || !rulesDirty.value) {
    draft.region = flag.rules.region;
    draft.appVersion = flag.rules.appVersion;
    draft.authenticated = flag.rules.authenticated;
    editingVersion.value = flag.version;
  }
  if (force || !rolloutDirty.value) rolloutDraft.value = flag.rollout;
  if (force || !scheduleDirty.value) scheduleDraft.value = plan.value?.scheduledAt ?? '';
}

watch(() => store.activeId, () => { conflict.value = null; remoteNotice.value = null; adoptActive(true); });
watch(() => active.value?.version, () => adoptActive(false));

function handleResult(res: SaveResult, scope: string, baseVersion: number) {
  if (res.ok) { conflict.value = null; return; }
  conflict.value = { scope, baseVersion, currentVersion: res.currentVersion, updatedBy: res.updatedBy, updatedAt: res.updatedAt };
}

function saveRules() { if (active.value) handleResult(store.saveRules(editingVersion.value, { ...draft }), '规则', editingVersion.value); }
function saveRollout() { if (active.value) handleResult(store.saveRollout(active.value.version, rolloutDraft.value), '放量配置', active.value.version); }
function saveSchedule() { if (active.value) handleResult(store.saveSchedule(active.value.version, scheduleDraft.value), '定时生效', active.value.version); }
function doApprove(role: string) { if (active.value) handleResult(store.approve(active.value.version, role), '审批', active.value.version); }
function doStart() { if (active.value) handleResult(store.startRollout(active.value.version), '开始灰度', active.value.version); }

/** 放弃本标签页的本地修改，加载最新版本 */
function loadLatest() {
  store.syncFromStorage();
  conflict.value = null;
  remoteNotice.value = null;
  adoptActive(true);
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY || !active.value) return;
  const previousVersion = active.value.version;
  store.syncFromStorage();
  const current = active.value;
  if (current && current.version !== previousVersion) {
    if (rulesDirty.value || rolloutDirty.value) {
      remoteNotice.value = { currentVersion: current.version, updatedBy: current.updatedBy, updatedAt: current.updatedAt };
    } else {
      adoptActive(false);
    }
  }
}

onMounted(() => { adoptActive(true); window.addEventListener('storage', onStorage); });
onUnmounted(() => window.removeEventListener('storage', onStorage));

const create = handleSubmit((values) => {
  store.createFlag(values.name, values.key);
  createOpen.value = false;
  resetForm();
});
function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}% · v{{ item.version }}</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form><a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" /></a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="内容版本"><a-tag color="purple">v{{ active.version }}</a-tag><span class="muted">{{ active.updatedBy || '历史数据' }}<template v-if="active.updatedAt"> · {{ active.updatedAt }}</template></span></a-descriptions-item>
                <a-descriptions-item label="当前版本审批">
                  <a-space v-if="effectiveApprovals.length" :size="4" wrap>
                    <a-tag v-for="entry in effectiveApprovals" :key="entry.role" color="green">{{ entry.role }}<template v-if="entry.at"> · {{ entry.at }}</template></a-tag>
                  </a-space>
                  <span v-else class="muted">待审批</span>
                  <a-tooltip v-for="entry in staleApprovals" :key="`${entry.role}-${entry.version}`" :title="`${entry.role} 批准的是 v${entry.version}，版本改动后该审批已失效（保留备查）`">
                    <a-tag class="stale-tag">{{ entry.role }} · v{{ entry.version }} 已失效<template v-if="entry.legacy">（历史）</template></a-tag>
                  </a-tooltip>
                </a-descriptions-item>
              </a-descriptions>

              <a-alert v-if="conflict" class="mt" type="error" show-icon
                :message="`${conflict.scope}保存失败：内容已变化（当前 v${conflict.currentVersion}）`"
                :description="`${conflict.updatedBy || '另一个标签页'} 于 ${conflict.updatedAt || '刚刚'} 先保存了新版本，你基于 v${conflict.baseVersion} 的本次修改未写入任何内容。请加载最新内容后再改。`">
                <template #action><a-button size="small" danger @click="loadLatest">放弃本地修改，加载最新</a-button></template>
              </a-alert>
              <a-alert v-else-if="remoteNotice" class="mt" type="warning" show-icon
                :message="`另一个标签页已保存 v${remoteNotice.currentVersion}`"
                :description="`${remoteNotice.updatedBy} 于 ${remoteNotice.updatedAt} 保存了新版本。你有未保存的本地修改，此时保存将提示内容已变化、不会覆盖。`">
                <template #action><a-button size="small" @click="loadLatest">加载最新内容</a-button></template>
              </a-alert>

              <a-divider>规则组合<span class="version-hint">（编辑基线 v{{ editingVersion }}<template v-if="editingVersion !== active.version"> · 已落后于 v{{ active.version }}</template>）</span></a-divider>
              <a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select v-model:value="draft.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input v-model:value="draft.appVersion" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch v-model:checked="draft.authenticated" /></a-form-item></a-col></a-row>
                <a-space><a-button type="primary" :disabled="!rulesDirty" @click="saveRules">保存规则（v{{ editingVersion }}）</a-button><span class="muted">保存会产生新版本，原审批失效；定时与进行中放量退回重新确认</span></a-space>
              </a-form>

              <a-divider>逐步放量</a-divider>
              <a-slider v-model:value="rolloutDraft" :min="0" :max="100" :step="5" />
              <a-space><span class="rollout-label">{{ rolloutDraft }}% 用户可命中</span><a-button :disabled="!rolloutDirty" @click="saveRollout">保存放量（基于 v{{ active.version }}）</a-button><span v-if="rolloutDirty" class="muted">未保存</span></a-space>

              <a-divider>定时生效</a-divider>
              <a-space wrap>
                <a-input v-model:value="scheduleDraft" type="datetime-local" style="width: 230px" />
                <a-button :disabled="!scheduleDirty" @click="saveSchedule">保存定时（基于 v{{ active.version }}）</a-button>
                <a-tag v-if="plan.scheduledAt && scheduleArmed" color="blue">定时已挂接 v{{ plan.scheduleVersion }}</a-tag>
                <a-tag v-else-if="plan.scheduledAt" color="default">定时挂接旧版本，已退回，需重新确认</a-tag>
                <span v-else class="muted">未设置定时</span>
              </a-space>
              <a-alert v-if="plan.scheduledAt && !scheduleArmed" class="mt" type="warning" show-icon message="定时随版本变更失效" description="原定时间保留备查，但只有把定时重新挂接到当前版本并完成该版本的双审批后，才会按时生效。" />

              <a-divider>审批与发布</a-divider>
              <a-space wrap>
                <a-button :disabled="effectiveApprovals.some(a => a.role === '产品负责人')" @click="doApprove('产品负责人')">产品审批</a-button>
                <a-button :disabled="effectiveApprovals.some(a => a.role === '研发负责人')" @click="doApprove('研发负责人')">研发审批</a-button>
                <a-button type="primary" :disabled="effectiveApprovals.length < 2 || (active.status !== 'approved' && active.status !== 'scheduled')" @click="doStart">开始灰度发布</a-button>
                <span class="muted">审批记录固定在批准时的 v{{ active.version }} 上；该版本需双方审批齐备方可放量</span>
              </a-space>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.muted { color: #8c8c8c; font-size: 12px; }
.version-hint { color: #8c8c8c; font-size: 12px; font-weight: 400; margin-left: 8px; }
.stale-tag { color: #bfbfbf; border-color: #f0f0f0; background: #fafafa; margin-left: 6px; text-decoration: line-through; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
