#!/usr/bin/env node
/* ============================================================
 * roco-world 培养页审计断言（第 15 期，配合 AUDIT-train14.md）
 *
 * 用法（仓库根目录）：
 *   node tools/audit_train.mjs
 *
 * 做什么：用与 tools/gen_rotation.mjs 同款的 vm harness 离线抽取
 * web/index.html 内联脚本，对全部 662 只精灵跑 buildCard，按第 14 期
 * 审计的口径逐项断言。任一断言失败 → 非零退出（推送前必须先跑通）。
 *
 * 断言清单：
 *  1. 归属层：配招字段与 skills.json 逐字段一致、来源分类与 learnset
 *     一致、无重复招、血脉来源技能 ≤1、配招满 4 招（池本身不足除外）。
 *  2. 自损招：desc 明文自毁的技能不得是第一输出招（有效威力最高的
 *     攻击招）；若兜底入选，why 必须明示自毁代价。
 *  3. 性格与配招互看：主推/备选的减项不得命中第一输出招的攻项；
 *     主推加项若是攻击项必须与第一输出招同侧；why 不许对配招在用
 *     的攻击项说「用不上/几乎不用」。附录 A 的 40 只逐只点名复验。
 *  4. 静态能耗特性：abilityEnergyAdj 能解析的特性，配招每招展示
 *     能耗 dispEnergy 必须等于基础值 + 修正（下限 0），且卡上必须
 *     有对应注记；学院呱呱专项：四招全部 +2。
 *  5. 技能位硬限制：特性 desc 含「仅可使用…号位技能」的精灵，
 *     培养卡必须带「⚠ 待核验」注记。
 *  6. 辅助位标签：标签必须与 desc 机制一致——「驱散」只给驱散敌方
 *     类、「回复」只给回复生命类、「回复能量」只给回复能量类；
 *     驱散/交换类禁止标「增益」。
 *  7. 「错开能耗」声称：why 含此语时，该招与第一招能耗差必须 ≥2。
 *  8. 坦克个体值：isTank 精灵的个体值前三必须恰为体力/物防/魔防。
 *  9. 降价机制招：isPriceDrop 命中的技能（现仅「抛石」）不得作为
 *     常规输出入选；兜底入选时 why 必须注明降价机制。
 * 10. 改血脉理由：解锁技能为变化类（无威力）时，理由禁止出现
 *     「反手打回去/补上新打击面/吃本系加成」等攻击话术；配招保留
 *     的血脉技能与改血脉首选必须一致（第 13 期回归）。
 * ============================================================ */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'web', 'data');

function loadModel(){
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html 内联脚本未找到');
  const el = () => ({ innerHTML: '', style: {}, querySelectorAll: () => [], addEventListener(){} });
  const ctx = {
    console, Promise, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    Infinity, NaN, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
    document: { getElementById: el, querySelectorAll: () => [], addEventListener(){} },
    location: { hash: '#/' },
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    fetch: () => Promise.reject(new Error('offline-harness')),
    navigator: { userAgent: 'audit-train' },
  };
  ctx.window = { addEventListener(){}, scrollTo(){}, location: ctx.location };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'index-inline.js' });
  const D = p => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));
  ctx.DB.pets = D('pets.json');
  ctx.DB.skills = D('skills.json');
  const ev = D('evolutions.json');
  ctx.DB.chains = ev.chains || ev;
  ctx.DB.images = {};
  ctx.DB.chart = D('typechart.json');
  ctx.DB.natures = D('natures.json');
  ctx.buildIndex();
  return ctx;
}

const A = loadModel();
const pets = A.DB.pets;
const rawSkills = JSON.parse(fs.readFileSync(path.join(DATA, 'skills.json'), 'utf8'));
const skillCanon = {};
rawSkills.filter(s => s.category !== '特性').forEach(s => { if (!skillCanon[s.name]) skillCanon[s.name] = s; });

const SELF_RE = /(使用后)?(消耗|耗尽)(自己|自身)?全部生命|失去全部(生命|体力)/;
const fails = [];
function fail(item, pet, detail){ fails.push({ item, pet: pet ? `${pet.name}（No.${pet.no}）` : '-', detail }); }
function isAtk(sk){ return sk && sk.power != null && (sk.category === '物理' || sk.category === '魔法'); }
function rawPool(p){
  const seen = {}, out = [];
  const add = (name, src, bloodType = null) => {
    if (!name || seen[name]) return; seen[name] = 1;
    const sk = skillCanon[name]; if (sk) out.push({ name, src, bloodType, skill: sk });
  };
  (p.learnset.level || []).forEach(x => add(x.skill, 'level'));
  (p.learnset.stone || []).forEach(n => add(n, 'stone'));
  (p.learnset.bloodline || []).forEach(b => add(b.skill, 'blood', b.type));
  return out;
}
/* 第 14 期附录 A：主推性格减项命中配招第一输出招攻项的 40 只（逐只点名复验） */
const APPENDIX_A = ['迪莫','圣光迪莫','圣草迪莫','圣火迪莫','圣水迪莫','喵呜','幻灵菇','矿晶虫','咔咔羽毛','咔咔雀','咔咔鸟','风铃鲨','蓝蝶鲨','彩蝶鲨','神谕鲨','石石','多啦多','古啦多','尖嘴狐仙','灵羽勇士','公平鸽','公平鸽（称量的样子）','消波螺','消波螺（被污染的样子）','棋祈督（白子）','棋祈督（黑子）','花怨鳗','花怨鳗（果壳铃的样子）','鳗尾兽','鳗尾兽（果壳铃的样子）','寒音蛇','绒绒','小绒茧','绒仙子','嗜光嗡嗡','加油海葵','加油蟹（两只海葵的样子）','咕咕帽','咕德帽帽','雷神之子'];

const stats = { moves: 0, staticAdjPets: 0, slotPets: 0, appendixA: 0 };
const cards = new Map();
for (const p of pets) cards.set(p.id, A.buildCard(p));

for (const p of pets) {
  const card = cards.get(p.id);
  const pool = rawPool(p);
  const byName = {}; pool.forEach(e => { byName[e.name] = e; });

  /* 1. 归属层 */
  const seenNames = {};
  for (const mv of card.moves) {
    stats.moves++;
    if (seenNames[mv.skill.name]) fail('归属', p, `配招重复：${mv.skill.name}`);
    seenNames[mv.skill.name] = 1;
    const can = skillCanon[mv.skill.name], exp = byName[mv.skill.name];
    if (!can || !exp) { fail('归属', p, `技能不在 learnset：${mv.skill.name}`); continue; }
    for (const f of ['type', 'category', 'power', 'energy'])
      if (mv.skill[f] !== can[f]) fail('归属', p, `${mv.skill.name} 字段 ${f} 不符：${mv.skill[f]} ≠ ${can[f]}`);
    if (mv.src !== exp.src || (mv.bloodType || null) !== (exp.bloodType || null))
      fail('归属', p, `${mv.skill.name} 来源分类不符：${mv.src}/${mv.bloodType} ≠ ${exp.src}/${exp.bloodType}`);
  }
  if (card.moves.filter(x => x.src === 'blood').length > 1) fail('归属', p, '血脉技能 ≥2（第 13 期互斥规则）');
  if (card.moves.length < 4 && pool.length >= 4) fail('归属', p, `配招只有 ${card.moves.length} 招但技能池有 ${pool.length} 招`);

  /* 第一输出招（有效威力最高的攻击招）与配招实际用到的攻击向 */
  const ats = card.moves.filter(x => isAtk(x.skill));
  let firstKey = null, firstEff = -1;
  const useCount = { atk: 0, spa: 0 };
  for (const x of ats) {
    const k = x.skill.category === '物理' ? 'atk' : 'spa';
    useCount[k]++;
    const e = A.effPower(p, x.skill);
    if (e > firstEff) { firstEff = e; firstKey = k; }
  }

  /* 2. 自损招 */
  for (const x of ats) {
    if (!SELF_RE.test(x.skill.desc || '')) continue;
    const k = x.skill.category === '物理' ? 'atk' : 'spa';
    if (k === firstKey && A.effPower(p, x.skill) >= firstEff)
      fail('自损招', p, `${x.skill.name} 是第一输出招（desc 明文自毁）`);
    if (!/消耗全部生命|最后一搏/.test(x.why || ''))
      fail('自损招', p, `${x.skill.name} 入选但 why 未明示自毁代价`);
  }

  /* 3. 性格与配招互看 */
  for (const [which, n] of [['主推', card.natMain], ['备选', card.natAlt]]) {
    if (!n) { fail('性格', p, `${which}缺失`); continue; }
    if (firstKey && n.minus === firstKey)
      fail('性格', p, `${which}「${n.name}」减项 ${n.minus} 命中第一输出招攻项`);
    if (which === '主推' && firstKey && (n.plus === 'atk' || n.plus === 'spa') && n.plus !== firstKey)
      fail('性格', p, `主推「${n.name}」加项 ${n.plus} 与第一输出招攻项 ${firstKey} 反侧`);
    const bad = (n.why || '').match(/减掉(用不上|几乎不用)的(物攻|魔攻)/);
    if (bad) {
      const k = bad[2] === '物攻' ? 'atk' : 'spa';
      if (useCount[k] > 0) fail('性格', p, `${which} why 称「减掉${bad[1]}的${bad[2]}」但配招在用该攻项（${useCount[k]} 招）`);
    }
  }
  if (APPENDIX_A.includes(p.name)) {
    stats.appendixA++;
    if (card.natMain && firstKey && card.natMain.minus === firstKey)
      fail('性格·附录A', p, `附录 A 名单未归零：主推减项仍命中第一输出招攻项 ${firstKey}`);
    if (card.natMain && firstKey && (card.natMain.plus === 'atk' || card.natMain.plus === 'spa') && card.natMain.plus !== firstKey)
      fail('性格·附录A', p, `附录 A 名单未归零：主推加项仍在非第一输出侧 ${card.natMain.plus}`);
  }

  /* 4. 静态能耗特性展示 */
  const ea = A.abilityEnergyAdj(p, card.moves);
  if (ea) {
    stats.staticAdjPets++;
    for (const mv of card.moves) {
      const dv = ea.adj[mv.skill.name] || 0;
      const want = dv ? Math.max(0, (mv.skill.energy != null ? mv.skill.energy : 0) + dv) : null;
      if ((mv.dispEnergy != null ? mv.dispEnergy : null) !== want)
        fail('能耗修正', p, `${mv.skill.name} 展示能耗 ${mv.dispEnergy} ≠ 应修正值 ${want}（基础 ${mv.skill.energy} + ${dv}）`);
    }
    if (!(card.abilityNotes || []).some(t => t.includes('上方 ★ 已按实际能耗修正') || t.includes('此减耗不触发') || t.includes('此减耗不生效') || t.includes('★ 为基础值')))
      fail('能耗修正', p, '有静态能耗修正但卡上无对应注记');
  } else if (card.moves.some(x => x.dispEnergy != null)) {
    fail('能耗修正', p, '无静态能耗特性却出现 dispEnergy');
  }
  if (p.name === '学院呱呱') {
    for (const mv of card.moves)
      if (mv.dispEnergy !== (mv.skill.energy || 0) + 2)
        fail('能耗修正·专项', p, `学院呱呱 ${mv.skill.name} 展示能耗应为基础 +2，实际 dispEnergy=${mv.dispEnergy}`);
  }

  /* 5. 技能位硬限制注记 */
  const ab = p.ability ? A.DB.abilityByName[p.ability] : null;
  const abd = ab ? String(ab.desc || '') : '';
  if (/仅可(?:以)?使用(?:是)?[0-9号、和]+号位技能/.test(abd)) {
    stats.slotPets++;
    if (!(card.abilityNotes || []).some(t => t.startsWith('⚠ 待核验')))
      fail('技能位注记', p, `特性「${p.ability}」限制技能位，但培养卡无待核验注记`);
  }

  /* 6. 辅助位标签 & 7. 错开能耗声称 */
  card.moves.forEach((mv, idx) => {
    const why = mv.why || '', sk = mv.skill, d = sk.desc || '';
    if (why.startsWith('辅助位：')) {
      const lm = why.match(/带「([^」]+)」效果/);
      const labs = lm ? lm[1].split('、') : [];
      if (labs.includes('驱散') && !/驱散敌方/.test(d)) fail('辅助标签', p, `${sk.name} 标「驱散」但 desc 无驱散敌方`);
      if (labs.includes('回复') && !/回复\d+%\s*生命|回复生命|回复\d+点生命/.test(d)) fail('辅助标签', p, `${sk.name} 标「回复」但 desc 非回复生命`);
      if (labs.includes('回复能量') && !/回复[^。；]*能量/.test(d)) fail('辅助标签', p, `${sk.name} 标「回复能量」但 desc 无回复能量`);
      if (labs.includes('增益') && /驱散敌方|交换/.test(d)) fail('辅助标签', p, `${sk.name} 是驱散/交换类却标「增益」`);
      if (/驱散敌方/.test(d) && !labs.includes('驱散')) fail('辅助标签', p, `${sk.name} 是驱散敌方类但标签缺「驱散」（现标签：${labs.join('、')}）`);
    }
    if (why.includes('错开能耗')) {
      const e0 = card.moves[0] && card.moves[0].skill.energy, e1 = sk.energy;
      if (e0 == null || e1 == null || Math.abs(e0 - e1) < 2)
        fail('错开能耗', p, `${sk.name} 声称错开能耗但与第一招能耗差 <2（${e0} vs ${e1}）`);
    }
  });

  /* 8. 坦克个体值 */
  const st = p.stats;
  const isTank = st.atk < 95 && st.spa < 95 && (st.def >= 100 || st.spd >= 100 || st.hp >= 120);
  if (isTank) {
    const keys = card.ivs.map(v => v.key).sort().join(',');
    if (keys !== 'def,hp,spd') fail('坦克个体值', p, `坦克个体值前三应为体力/物防/魔防，实际 ${card.ivs.map(v => v.label).join('/')}`);
  }

  /* 9. 降价机制招 */
  for (const mv of card.moves) {
    if (A.isPriceDrop(mv.skill) && !/降价机制/.test(mv.why || ''))
      fail('降价机制招', p, `${mv.skill.name} 作为常规输出入选（应被排除或注明降价机制）`);
  }

  /* 10. 改血脉理由 */
  const kept = card.moves.find(x => x.src === 'blood');
  if (kept && (card.bloods.length !== 1 || card.bloods[0].skill.name !== kept.skill.name))
    fail('改血脉', p, `配招保留血脉技能 ${kept.skill.name}，但改血脉首选与之不一致`);
  for (const b of card.bloods) {
    if ((b.skill.category === '变化' || b.skill.power == null) &&
        /反手打回去|补上新打击面|补打击面|解锁的技能吃本系加成/.test(b.why || ''))
      fail('改血脉', p, `变化类技能「${b.skill.name}」的推荐理由含攻击话术：${(b.why || '').slice(0, 60)}…`);
  }
}

console.log(`[audit_train] 精灵 ${pets.length} 只 / 配招 ${stats.moves} 招 / 静态能耗注记 ${stats.staticAdjPets} 只 / 技能位限制 ${stats.slotPets} 只 / 附录 A 复验 ${stats.appendixA} 只`);
if (fails.length) {
  console.error(`[audit_train] 失败 ${fails.length} 项：`);
  for (const f of fails.slice(0, 60)) console.error(`  ✗ [${f.item}] ${f.pet}：${f.detail}`);
  if (fails.length > 60) console.error(`  …另有 ${fails.length - 60} 项`);
  process.exit(1);
}
console.log('[audit_train] 全部断言通过 ✓');
