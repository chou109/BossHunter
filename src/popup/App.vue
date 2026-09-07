<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { loadConfig, saveConfig } from '../lib/config'
import { BOSS_ACTIVE_LABELS } from '../lib/types'
import type { AppConfig, BossActive } from '../lib/types'

const cfg = reactive<AppConfig>({
  enabled: true,
  batchApply: true,
  autoGreet: true,
  greetTemplate: '',
  applyDelayMs: 2000,
  deliveryLimit: 120,
  targetCount: 20,
  filters: {
    jobTitle: { enable: false, include: true, value: [] },
    company: { enable: false, include: true, value: [] },
    tags: { enable: false, include: true, value: [] },
    daySalary: { enable: false, min: 0, max: 0, strict: false, contains: false },
    monthlySalary: { enable: false, min: 0, max: 0, strict: false, contains: false },
    hourlySalary: { enable: false, min: 0, max: 0, strict: false, contains: false },
    bossActive: 'none',
    experience: 'none',
    onlyIntern: false,
    excludeNegotiable: false,
    bossOnlineOnly: false,
    goldHunter: false,
    bossGoldMedalHr: false,
    friendStatus: false,
  },
})

/** 关键词文本框草稿（存数组不方便 v-model，保存时再拆分） */
const kwDraft = reactive<Record<string, string>>({ jobTitle: '', company: '', tags: '' })
const KW_KEYS = ['jobTitle', 'company', 'tags'] as const

const activeOptions = (Object.keys(BOSS_ACTIVE_LABELS) as BossActive[]).map((k) => ({
  value: k,
  label: BOSS_ACTIVE_LABELS[k],
}))

/** 薪资下拉档位：value 为 "key-min-max"，min/max=0 表示不限 */
const SALARY_BANDS: Record<string, { value: string; label: string }[]> = {
  daySalary: [
    { value: '0-0', label: '日薪不限' },
    { value: '100-0', label: '100元/天以上' },
    { value: '150-0', label: '150元/天以上' },
    { value: '200-0', label: '200元/天以上' },
    { value: '250-0', label: '250元/天以上' },
    { value: '300-0', label: '300元/天以上' },
    { value: '400-0', label: '400元/天以上' },
  ],
  hourlySalary: [
    { value: '0-0', label: '时薪不限' },
    { value: '50-0', label: '50元/时以上' },
    { value: '80-0', label: '80元/时以上' },
    { value: '100-0', label: '100元/时以上' },
    { value: '150-0', label: '150元/时以上' },
    { value: '200-0', label: '200元/时以上' },
  ],
  monthlySalary: [
    { value: '0-0', label: '月薪不限' },
    { value: '3-0', label: '3K以上' },
    { value: '4-0', label: '4K以上' },
    { value: '5-0', label: '5K以上' },
    { value: '10-0', label: '10K以上' },
    { value: '20-0', label: '20K以上' },
    { value: '50-0', label: '50K以上' },
  ],
}
/** 薪资下拉框当前选中值（min-max 字符串），与档位联动 */
const salarySel = reactive<Record<string, string>>({ daySalary: '0-0', hourlySalary: '0-0', monthlySalary: '0-0' })
/** 把当前启用的薪资档位转成下拉框值 */
function salarySelValue(key: keyof typeof SALARY_BANDS): string {
  const r = cfg.filters[key]
  const v = `${r.min || 0}-${r.max || 0}`
  return SALARY_BANDS[key].some((o) => o.value === v) ? v : '0-0'
}
/** 从 cfg 回填薪资下拉值 */
function syncSalarySel() {
  for (const key of Object.keys(SALARY_BANDS) as (keyof typeof SALARY_BANDS)[]) salarySel[key] = salarySelValue(key)
}
/** 选择档位后写回 RangeSetting（enable 由选中项是否"不限"决定） */
function onSalaryChange(key: keyof typeof SALARY_BANDS) {
  const [min, max] = salarySel[key].split('-').map(Number)
  cfg.filters[key].enable = (min || 0) > 0 || (max || 0) > 0
  cfg.filters[key].min = min || 0
  cfg.filters[key].max = max || 0
}

const loading = ref(true)
const saved = ref(false)
const phJob = '{{jobName}}'
const phCompany = '{{company}}'
const phBoss = '{{bossName}}'

onMounted(async () => {
  const c = await loadConfig()
  Object.assign(cfg, c)
  for (const k of KW_KEYS) kwDraft[k] = (cfg.filters[k].value ?? []).join('\n')
  syncSalarySel()
  loading.value = false
})

async function save() {
  for (const k of KW_KEYS) {
    const words = kwDraft[k]
      .split(/[\n,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
    cfg.filters[k].value = words
    cfg.filters[k].enable = words.length > 0
  }
  await saveConfig(cfg)
  saved.value = true
  setTimeout(() => (saved.value = false), 1200)
}
</script>

<template>
  <div class="wrap" v-if="!loading">
    <h1>BossHunter</h1>

    <section class="card">
      <h2>基础</h2>
      <label class="row"><span>启用扩展</span><input type="checkbox" v-model="cfg.enabled" /></label>
      <label class="row"><span>批量投递</span><input type="checkbox" v-model="cfg.batchApply" /></label>
      <label class="row"><span>自动打招呼</span><input type="checkbox" v-model="cfg.autoGreet" /></label>
      <label class="field"><span>每日最大投递数</span><input type="number" v-model.number="cfg.deliveryLimit" min="1" /></label>
      <label class="field"><span>投递间隔(毫秒)</span><input type="number" v-model.number="cfg.applyDelayMs" min="200" step="100" /></label>
    </section>

    <section class="card highlight">
      <h2>薪资筛选 <em>（网页端缺失，移动端独有）</em></h2>
      <div class="range" v-for="(label, key) in { daySalary: '日薪(元/天)', hourlySalary: '时薪(元/时)', monthlySalary: '月薪(K)' }" :key="key">
        <label class="row"><span>{{ label }}</span></label>
        <select v-model="salarySel[key]" @change="onSalaryChange(key)">
          <option v-for="o in SALARY_BANDS[key]" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <label class="row small"><span>只要薪资包含设置金额即可</span><input type="checkbox" v-model="cfg.filters.daySalary.contains" /></label>
      <p class="tip">勾选=薪资区间包含设置金额即可；不勾=最低须达到设置金额。选「不限」即关闭对应筛选。</p>
    </section>

    <section class="card">
      <h2>关键词筛选</h2>
      <div class="range" v-for="(label, key) in { jobTitle: '职位名', company: '公司名', tags: '标签/技能' }" :key="key">
        <label class="row">
          <span>{{ label }}（{{ cfg.filters[key].include ? '只留命中' : '剔除命中' }}）</span>
          <input type="checkbox" v-model="cfg.filters[key].include" />
        </label>
        <label class="field">
          <span>每行一组；空格分隔的词需全部命中</span>
          <textarea v-model="kwDraft[key]" rows="2" placeholder="如：前端&#10;外包 派遣"></textarea>
        </label>
      </div>
    </section>

    <section class="card highlight">
      <h2>Boss 活跃状态 <em>（同移动端）</em></h2>
      <label class="field">
        <select v-model="cfg.filters.bossActive">
          <option v-for="o in activeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <p class="tip">筛选出最近满足活跃条件的 Boss。选择「不限」表示关闭该筛选。</p>
    </section>

    <section class="card">
      <h2>其他过滤</h2>
      <label class="row"><span>猎头过滤</span><input type="checkbox" v-model="cfg.filters.goldHunter" /></label>
      <label class="row"><span>金牌面试官过滤</span><input type="checkbox" v-model="cfg.filters.bossGoldMedalHr" /></label>
      <label class="row"><span>已沟通/好友过滤</span><input type="checkbox" v-model="cfg.filters.friendStatus" /></label>
    </section>

    <section class="card">
      <h2>招呼语</h2>
      <label class="field">
        <span>模板（{{ phJob }} / {{ phCompany }} / {{ phBoss }}）</span>
        <textarea v-model="cfg.greetTemplate" rows="3"></textarea>
      </label>
    </section>

    <button class="save" @click="save">保存配置</button>
    <span v-if="saved" class="ok">已保存 ✓</span>
    <p class="hint">打开 Boss直聘职位列表页，右侧会出现控制面板。若职位读不到/数据不对，点面板「调试」并把日志发我。</p>
  </div>
</template>
