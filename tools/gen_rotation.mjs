#!/usr/bin/env node
/* ============================================================
 * roco-world 阵容轮换生成器（第 8 期）
 *
 * 用法（cron 每 48 小时调用一次，工作目录 = 仓库根目录）：
 *   node tools/gen_rotation.mjs
 *
 * 做什么：
 *   1. 读取 web/index.html 的内联脚本，在 Node vm 里以浏览器 stub 运行，
 *      复用页面同款模型函数（scoreTeam / typeMult / effPower / squadLinks
 *      及其证据表 / 第 6、7 期全部构建器）——页面与生成器永远同一套口径。
 *   2. 战术池 17 个战术（天气 4 + 机制 5 + 基础 3 + 本期新增混搭 5+1），
 *      每个战术多次构建 + 局部爬山优化，取综合分最高版本（best-of-N，
 *      强度优先：质量门槛 ≥58 是下限，目标 ≥60）。
 *   3. 轮换约束：与上一轮每套重合 ≤2 只、本轮 3 套战术互异且成员两两
 *      重合 ≤2；放宽顺序 = 先换战术组合 → 再把重合降到 ≤3 并标注
 *      relaxed:true → 绝不降质量门槛。
 *   4. 结果写 web/data/rotation.json（结构见 README「阵容轮换」一节），
 *      上一轮成员名单存入 prevSquads 供下一轮避重复。
 *
 * 种子由上一轮的 generatedAt + 轮次号派生：同一输入（同一份旧
 * rotation.json + 同一份数据）重复运行结果一致，可复现。
 * ============================================================ */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'web', 'data');
const ROT_PATH = path.join(DATA_DIR, 'rotation.json');
const DEBUG = !!process.env.ROT_DEBUG;

function log(...a){ console.log('[gen_rotation]', ...a); }
function dbg(...a){ if (DEBUG) log(...a); }

/* ---------------- 1. harness：抽取页面内联脚本并注入数据 ---------------- */
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
    navigator: { userAgent: 'gen-rotation' },
  };
  ctx.window = { addEventListener(){}, scrollTo(){}, location: ctx.location };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'index-inline.js' });
  const D = p => JSON.parse(fs.readFileSync(path.join(DATA_DIR, p), 'utf8'));
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
const A = loadModel();           // 页面模型 API（函数与数据都在 vm 上下文里）
const TYPES18 = A.TYPES18;

/* ---------------- 2. 可复现随机数（mulberry32 + 字符串种子） ---------------- */
function hashSeed(str){
  let h = 2166136261;
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 3. 本期新机制判定（全部来自 desc 原文扫描） ----------------
 * 挖掘结论（2026-11-19 全量扫描 skills.json 861 条 desc，详见 README）：
 * - 层数型异常状态只有四种：中毒（施加 33 条/296 只）、灼烧（19/403）、
 *   冻结（22/293）、寄生（5/62）；本作没有睡眠、麻痹（单字扫描均为 0）。
 * - 属性下降 31 条/531 只（格式为「敌方获得物攻-40%」等）；能耗压制
 *   13 条/349 只；驱散敌方增益 18 条/453 只。
 * - 联防证据：无「替队友承受/分摊」机制（0 条）；可用的是应对触发型
 *   技能（应对攻击/防御 + 额外效果）、入场增益特性 22 种/41 只、
 *   受击成长招（怨力打击/岩土暴击，仅 2 条，作点缀不作配额主体）。 */
const STATUS_WORDS = ['中毒', '灼烧', '冻结', '寄生'];
const DOWN_RE = /(物攻|魔攻|物防|魔防|速度|双攻|双防|命中)-\d/;

function descSegs(sk){ return String((sk && sk.desc) || '').split(/[。；]/); }
function entryOfSkill(sk){ return { n: sk.name, k: '技能' }; }
function abilityEntry(pet){
  if (!pet.ability) return null;
  const ab = A.DB.abilityByName[pet.ability];
  return ab ? { n: pet.ability, k: '特性', desc: ab.desc || '' } : null;
}
function allEntries(pet){
  /* 该精灵全部可引用条目：技能（learnset 并集）+ 特性，带 desc */
  const out = A.petSkills(pet).map(sk => ({ n: sk.name, k: '技能', desc: sk.desc || '', sk }));
  const ab = abilityEntry(pet);
  if (ab) out.push(ab);
  return out;
}
/* 某条目施加的异常状态（敌方获得 N 层 X） */
function statusAppliedByEntry(e){
  const out = [];
  for (const w of STATUS_WORDS){
    if (new RegExp('(获得|附加)[^。；]{0,5}' + w).test(e.desc)) out.push(w);
  }
  return out;
}
/* 某条目是否「消费」某状态（攻击带该状态的目标/敌方受该状态伤害时受益等） */
function statusConsumedByEntry(e, w){
  if (!e.desc.includes(w)) return false;
  if (statusAppliedByEntry(e).includes(w) && !/(目标|受到|每有|层数)/.test(e.desc)) return false;
  return /(目标|受到|每有|层数|伤害时)/.test(e.desc);
}
function entryHasDown(e){
  return descSegs(e).some(s => s.includes('敌方') && DOWN_RE.test(s));
}
function entryHasTax(e){
  return descSegs(e).some(s => /能耗\+/.test(s) && /(敌方|全技能)/.test(s));
}
function entryHasDispel(e){
  return descSegs(e).some(s => s.includes('驱散') && s.includes('敌方'));
}
function entryHasRespond(e){
  /* 应对触发且带额外效果（挂状态/降属性/驱散/回血/减伤），纯姿态不算联防证据 */
  if (!/(应对攻击|应对防御|应对技能)/.test(e.desc)) return false;
  return statusAppliedByEntry(e).length > 0 || entryHasDown(e) || entryHasDispel(e) ||
    /回复[^。；]{0,5}(生命|体力)/.test(e.desc) || /减伤(6|7|8|9)\d%/.test(e.desc);
}
function entryHitGrowth(e){
  return /(被攻击|受到攻击|承受攻击|蓄力期间受到攻击)/.test(e.desc);
}
function petFlagsX(pet){
  if (pet._fx) return pet._fx;
  const es = allEntries(pet);
  const status = [];   // [{e, w}]
  const downs = [], taxes = [], dispels = [], responds = [], growths = [], consumers = [];
  es.forEach(e => {
    statusAppliedByEntry(e).forEach(w => status.push({ e, w }));
    if (entryHasDown(e)) downs.push(e);
    if (entryHasTax(e)) taxes.push(e);
    if (entryHasDispel(e)) dispels.push(e);
    if (entryHasRespond(e)) responds.push(e);
    if (entryHitGrowth(e)) growths.push(e);
    STATUS_WORDS.forEach(w => { if (statusConsumedByEntry(e, w)) consumers.push({ e, w }); });
  });
  const ab = abilityEntry(pet);
  const entryGuard = !!(ab && /入场/.test(ab.desc) && /(减伤|免疫|获得|回复)/.test(ab.desc));
  const f = {
    status, statusKinds: [...new Set(status.map(s => s.w))],
    downs, taxes, dispels, responds, growths, consumers,
    entryGuard,
    ctrlN: status.length + downs.length + taxes.length + dispels.length,
  };
  pet._fx = f;
  return f;
}
function burstOf(pet){
  /* 爆发口径：全部攻击招里最高的有效威力（页面 effPower：威力×本系×攻项匹配） */
  let best = 0;
  A.petSkills(pet).forEach(sk => { const v = A.effPower(pet, sk); if (v > best) best = v; });
  return best;
}
function evText(e){ return '「' + e.n + '」'; }

/* ---------------- 4. 配合链：页面 squadLinks + 本期状态联动检测 ---------------- */
function genLinks(def, members){
  const links = A.squadLinks(def, members).slice();
  const pets = members.map(m => m.pet);
  /* 状态联动：A 挂状态 W → B 有吃 W 的条目（攻击带状态目标/受状态伤害受益等） */
  pets.forEach(a => {
    const fa = petFlagsX(a);
    fa.status.forEach(sa => {
      pets.forEach(b => {
        if (b === a) return;
        const cons = petFlagsX(b).consumers.filter(c => c.w === sa.w);
        if (!cons.length) return;
        const ce = cons[0].e;
        const dup = links.some(L => L.a === a.name && L.via === sa.e.n && L.b === b.name);
        if (dup) return;
        const src = sa.e.k === '特性' ? A.DB.abilityByName[sa.e.n] : A.skillOf(sa.e.n);
        links.push({
          kind: 'status', a: a.name, via: sa.e.n, viaKind: sa.e.k, b: b.name,
          text: '先用' + sa.e.k + '「' + sa.e.n + '」给敌方挂上' + sa.w + '，' + b.name + '的' +
            ce.k + '「' + ce.n + '」正好吃这个状态——对带' + sa.w + '的目标收益更高，状态层数就是它的弹药',
          quote: A.descFirst(src ? src.desc : ''),
        });
      });
    });
  });
  /* 去重（a|via|b）后按 kind 多样性取前 4（页面检测结果优先保留） */
  const seen = {}, out = [];
  links.forEach(L => {
    const key = L.a + '|' + L.via + '|' + L.b;
    if (seen[key]) return;
    seen[key] = 1; out.push(L);
  });
  return out.slice(0, 4);
}

/* ---------------- 5. 组队通用工具（带抖动的贪心，种子可复现） ---------------- */
function pickJ(st, cands, fn, rng, jit){
  let best = null, bs = -Infinity;
  cands.forEach(p => {
    if (!A.squadAvail(st, p)) return;
    const s = fn(p) + (jit ? rng() * jit : 0);
    if (s > bs){ bs = s; best = p; }
  });
  return best;
}
function blindPickJ(st, rng, jit){
  const cur = st.members.map(m => m.pet);
  const wc = A.weakCounts(cur);
  const maxW = Math.max.apply(null, TYPES18.map(a => wc[a]));
  const weakTops = TYPES18.filter(a => wc[a] === maxW && maxW > 0);
  const curSuper = A.superCountOf(cur);
  let best = null, bs = -Infinity, bWhy = '';
  A.DB.pets.forEach(p => {
    if (!A.squadAvail(st, p)) return;
    const atk = A.petAtkTypes(p);
    const newSuper = A.superCountOf(cur.concat([p])) - curSuper;
    const anti = weakTops.filter(w => atk.some(t => A.typeMult(t, [w]) >= 2));
    const s = newSuper * 12 + anti.length * 10 + p.stats.total / 40 + (jit ? rng() * jit : 0);
    if (s > bs){
      bs = s; best = p;
      const bits = [];
      if (anti.length) bits.push('它的技能能 ×2 打 ' + anti.join('、') + '系，正克全队最怕的属性');
      if (newSuper > 0) bits.push('新增超效打击面 ' + newSuper + ' 种');
      if (!bits.length) bits.push('面板扎实，总和 ' + p.stats.total + '，补上队伍短板');
      bWhy = '补盲：' + bits.join('；') + '。';
    }
  });
  return best ? { pet: best, why: bWhy } : null;
}
function fillBlindJ(st, rng, jit, preferPool){
  while (st.members.length < 6){
    if (preferPool){
      const c = pickJ(st, preferPool, p => A.outScore(p) + A.synergyBonus(p, stPetsOf(st)), rng, jit);
      if (c){ A.squadAdd(st, c, '⚔️ 输出', A.outputWhy(c, '补位输出')); continue; }
    }
    const r = blindPickJ(st, rng, jit);
    if (!r) break;
    A.squadAdd(st, r.pet, '🧭 补盲', r.why);
  }
}
function stPetsOf(st){ return st.members.map(m => m.pet); }
function countType(pets, t){ return pets.filter(p => p.types.includes(t)).length; }
function profileRole(pet){
  if (A.duraOf(pet) >= 430) return '🛡️ 承伤位';
  if (pet.stats.spe >= 110) return '💨 高速位';
  if (Math.max(pet.stats.atk, pet.stats.spa) >= 115) return '⚔️ 输出位';
  if (A.sustainSkillsOf(pet).length >= 2) return '💚 续航位';
  return '⚔️ 输出位';
}
const PROFILE_ROLES = ['🛡️ 承伤位', '💨 高速位', '💚 续航位', '⚔️ 输出位', '🔗 配合核心'];
function roleAfterSwap(oldRole, pet){
  /* 画像类角色（互补队产生）随新成员画像重算；证据/语义类角色（补盲、天气手等）保留 */
  return PROFILE_ROLES.includes(oldRole) ? profileRole(pet) : oldRole;
}
function genericWhy(pet, role){
  const mv = A.bestOwnMove(pet);
  const side = pet.stats.atk >= pet.stats.spa ? '物攻 ' + pet.stats.atk : '魔攻 ' + pet.stats.spa;
  let extra = '';
  const sus = A.sustainSkillsOf(pet).length;
  if (sus) extra = '，带 ' + sus + ' 个真回复技能';
  else if (petFlagsX(pet).ctrlN) extra = '，带 ' + petFlagsX(pet).ctrlN + ' 个控制/异常条目';
  return '轮换补强位（' + role + '）：总和 ' + pet.stats.total + '，' + side + '、速度 ' + pet.stats.spe +
    (mv ? '，本系大招「' + mv.name + '」威力 ' + mv.power : '') + extra + '，补入后全队综合分更高。';
}

/* ---------------- 6. 本期新战术构建器 ---------------- */
function buildFiregrass(rng){
  const st = A.newSquadState();
  const pool = A.DB.pets.filter(p => p.types.includes('火') || p.types.includes('草'));
  const fires = pool.filter(p => p.types.includes('火'));
  const grasses = pool.filter(p => p.types.includes('草'));
  const fo = pickJ(st, fires, p => A.outScore(p) + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (fo) A.squadAdd(st, fo, '🔥 火系输出',
    A.outputWhy(fo, '火系输出') + '它怕的水、地两系，队里草系正好能 ×2 反打（克制表实测）。');
  const go = pickJ(st, grasses, p => A.outScore(p) + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (go) A.squadAdd(st, go, '🌿 草系输出',
    A.outputWhy(go, '草系输出') + '它怕的冰、虫两系，队里火系能 ×2 反打，火草互为盾牌。');
  const second = pickJ(st, pool, p => A.outScore(p) * 0.9 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (second) A.squadAdd(st, second, '⚔️ 核心输出', A.outputWhy(second, '火草第二输出'));
  const wall = pickJ(st, pool, p => A.duraOf(p) + A.sustainSkillsOf(p).length * 30, rng, 26);
  if (wall) A.squadAdd(st, wall, '🛡️ 前排续航',
    '前排担当：体力 ' + wall.stats.hp + '、双防 ' + wall.stats.def + '/' + wall.stats.spd +
    (A.sustainSkillsOf(wall).length ? '，带 ' + A.sustainSkillsOf(wall).length + ' 个真回复技能' : '') + '，总和 ' + wall.stats.total + '。');
  const ctrl = pickJ(st, pool, p => petFlagsX(p).ctrlN * 22 + p.stats.total * 0.2, rng, 26);
  if (ctrl && petFlagsX(ctrl).ctrlN > 0){
    const cf = petFlagsX(ctrl);
    const exEv = (cf.status[0] && cf.status[0].e) || cf.downs[0] || cf.taxes[0] || cf.dispels[0];
    A.squadAdd(st, ctrl, '☠️ 状态手',
      '带 ' + cf.ctrlN + ' 个控制/异常条目（如' + evText(exEv) +
      '），负责给对面挂状态、压节奏。总和 ' + ctrl.stats.total + '。');
  }
  fillBlindJ(st, rng, 18, pool);
  return st.members;
}
function buildGroundfight(rng){
  const st = A.newSquadState();
  const pool = A.DB.pets.filter(p => p.types.includes('地') || p.types.includes('武'));
  const grounds = pool.filter(p => p.types.includes('地'));
  const fights = pool.filter(p => p.types.includes('武'));
  const go1 = pickJ(st, grounds, p => A.outScore(p) + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (go1) A.squadAdd(st, go1, '🪨 地系输出',
    A.outputWhy(go1, '地系输出') + '地、武两系的弱点集零重叠（地怕水/草/冰/武/机械，武怕翼/萌/幻），没有一种属性能同时克制两系成员。');
  const fo1 = pickJ(st, fights, p => A.outScore(p) + p.stats.spe * 0.4 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (fo1) A.squadAdd(st, fo1, '🥋 武系输出',
    A.outputWhy(fo1, '武系输出') + '武系能 ×2 反打地系的克星冰、机械，地武在进攻端互相递刀。');
  const wall = pickJ(st, pool, p => A.duraOf(p) + p.stats.total * 0.15, rng, 26);
  if (wall) A.squadAdd(st, wall, '🛡️ 前排坦克',
    '前排担当：体力 ' + wall.stats.hp + '、双防 ' + wall.stats.def + '/' + wall.stats.spd + '，总和 ' + wall.stats.total + '，地/武双系里最能扛的一档。');
  const second = pickJ(st, pool, p => A.outScore(p) * 0.9 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (second) A.squadAdd(st, second, '⚔️ 核心输出', A.outputWhy(second, '地武第二输出'));
  fillBlindJ(st, rng, 18, null);   // 地的克星水/草、武的克星翼/萌/幻，地武内部解决不了，必须全球补盲
  return st.members;
}
function buildAttrition(rng){
  const st = A.newSquadState();
  const strong = A.DB.pets.filter(p => { const f = petFlagsX(p); return f.status.length >= 2 || f.statusKinds.length >= 2; });
  for (let i = 0; i < 2; i++){
    const ap = pickJ(st, strong, p => {
      const f = petFlagsX(p);
      return f.status.length * 25 + f.statusKinds.length * 15 + A.duraOf(p) * 0.25 + p.stats.total * 0.15 + A.synergyBonus(p, stPetsOf(st));
    }, rng, 26);
    if (!ap) break;
    const f = petFlagsX(ap);
    A.squadAdd(st, ap, '☠️ 状态手',
      '异常状态发动机：能挂 ' + f.statusKinds.join('、') + '（如' + evText(f.status[0].e) + '），' +
      '层数型状态每回合都在结算伤害，它活得越久对面掉得越多。耐久 ' + A.duraOf(ap) + '、总和 ' + ap.stats.total + '。');
  }
  const pressPool = A.DB.pets.filter(p => { const f = petFlagsX(p); return f.downs.length + f.taxes.length + f.dispels.length >= 1; });
  const pr = pickJ(st, pressPool, p => petFlagsX(p).ctrlN * 20 + A.duraOf(p) * 0.3 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (pr){
    const f = petFlagsX(pr);
    const kinds = [];
    if (f.downs.length) kinds.push('降属性（' + evText(f.downs[0]) + '）');
    if (f.taxes.length) kinds.push('能耗压制（' + evText(f.taxes[0]) + '）');
    if (f.dispels.length) kinds.push('驱散增益（' + evText(f.dispels[0]) + '）');
    A.squadAdd(st, pr, '🌀 压制位', '负责恶心对面：' + kinds.join('、') + '。耐久 ' + A.duraOf(pr) + '、总和 ' + pr.stats.total + '。');
  }
  const bulky = A.DB.pets.filter(p => A.duraOf(p) >= 380);
  for (let i = 0; i < 2; i++){
    const t = pickJ(st, bulky, p => A.duraOf(p) + A.sustainSkillsOf(p).length * 30 + petFlagsX(p).status.length * 10, rng, 26);
    if (!t) break;
    A.squadAdd(st, t, '🛡️ 耐久消耗',
      '消耗战的桩子：体力 ' + t.stats.hp + '、双防 ' + t.stats.def + '/' + t.stats.spd +
      (A.sustainSkillsOf(t).length ? '，带 ' + A.sustainSkillsOf(t).length + ' 个真回复技能' : '') +
      '——它站着回血，对面站着掉血。总和 ' + t.stats.total + '。');
  }
  const flex = pickJ(st, A.DB.pets, p => A.outScore(p) * 0.5 + A.sustainSkillsOf(p).length * 25 + petFlagsX(p).status.length * 12 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (flex) A.squadAdd(st, flex, '⚔️ 收割输出', A.outputWhy(flex, '等对面被状态磨残后收割的输出'));
  fillBlindJ(st, rng, 18, null);
  return st.members;
}
function buildBurst(rng){
  const st = A.newSquadState();
  const pool = A.DB.pets.filter(p => p.stats.spe >= 95);
  for (let i = 0; i < 5; i++){
    const p = pickJ(st, pool, x => x.stats.spe * 1.6 + burstOf(x) * 0.7 + x.stats.total * 0.15 +
      (burstOf(x) >= 130 ? 40 : 0) + A.synergyBonus(x, stPetsOf(st)), rng, 30);
    if (!p) break;
    A.squadAdd(st, p, i === 0 ? '🚀 爆发核心' : '⚡ 高速爆发',
      '速度 ' + p.stats.spe + '，最强一招有效威力 ' + Math.round(burstOf(p)) + '（' +
      (p.stats.atk >= p.stats.spa ? '物攻 ' + p.stats.atk : '魔攻 ' + p.stats.spa) + '侧），总和 ' + p.stats.total +
      '——先手一波压血，不给对面喘息。');
  }
  fillBlindJ(st, rng, 18, pool);
  return st.members;
}
function buildCounter(rng){
  const st = A.newSquadState();
  const evPool = A.DB.pets.filter(p => { const f = petFlagsX(p); return f.responds.length >= 1 || f.entryGuard || f.growths.length >= 1; });
  for (let i = 0; i < 2; i++){
    const p = pickJ(st, evPool, x => {
      const f = petFlagsX(x);
      return f.responds.length * 25 + (f.entryGuard ? 30 : 0) + f.growths.length * 20 + A.duraOf(x) * 0.35 + A.synergyBonus(x, stPetsOf(st));
    }, rng, 26);
    if (!p) break;
    const f = petFlagsX(p);
    const bits = [];
    if (f.responds.length) bits.push('应对触发（' + evText(f.responds[0]) + '：挨打/防住的同时反手挂效果）');
    if (f.entryGuard) bits.push('入场增益特性「' + p.ability + '」');
    if (f.growths.length) bits.push('受击成长（' + evText(f.growths[0]) + '）');
    A.squadAdd(st, p, '↩️ 联防位', '联防证据：' + bits.join('；') + '。耐久 ' + A.duraOf(p) + '、总和 ' + p.stats.total + '——对面打它等于给它递触发条件。');
  }
  const wall = pickJ(st, A.DB.pets, p => A.duraOf(p) + A.sustainSkillsOf(p).length * 20, rng, 26);
  if (wall) A.squadAdd(st, wall, '🛡️ 主坦',
    '主坦：体力 ' + wall.stats.hp + '、双防 ' + wall.stats.def + '/' + wall.stats.spd + '，总和 ' + wall.stats.total + '，负责把对面的爆发先吃下来。');
  const sus = pickJ(st, A.DB.pets, p => A.sustainSkillsOf(p).length * 30 + A.duraOf(p) * 0.5, rng, 26);
  if (sus && A.sustainSkillsOf(sus).length) A.squadAdd(st, sus, '💚 续航位',
    '带 ' + A.sustainSkillsOf(sus).length + ' 个真回复技能，耐久 ' + A.duraOf(sus) + '——联防队打的是回合数，它保证血线不崩。');
  const out = pickJ(st, A.DB.pets, p => A.outScore(p) + A.duraOf(p) * 0.2 + A.synergyBonus(p, stPetsOf(st)), rng, 26);
  if (out) A.squadAdd(st, out, '⚔️ 反击输出', A.outputWhy(out, '等对面打完再反打的输出'));
  fillBlindJ(st, rng, 18, null);
  return st.members;
}
function buildComplement(rng){
  const st = A.newSquadState();
  /* 先种一对配合锚点（供能→大招），保证配合链有据 */
  const feeders = A.DB.pets.filter(p => A.energyFeedOf(p).length > 0);
  const fd = pickJ(st, feeders, p => p.stats.total, rng, 30);
  if (fd) A.squadAdd(st, fd, '🔗 配合核心',
    '供能锚点：会「' + A.energyFeedOf(fd)[0].n + '」给队友补能量，整队的配合链从它开始。总和 ' + fd.stats.total + '。');
  const spenders = A.DB.pets.filter(p => !!A.displayBigMove(p, 7));
  const sp = pickJ(st, spenders, p => A.outScore(p), rng, 30);
  if (sp){
    const big = A.displayBigMove(sp, 7);
    A.squadAdd(st, sp, '🔗 配合核心',
      '大招锚点：「' + big.name + '」（能耗★' + big.energy + '、威力 ' + big.power + '）靠供能链喂饱。总和 ' + sp.stats.total + '。');
  }
  while (st.members.length < 6){
    const cur = stPetsOf(st);
    let best = null, bs = -Infinity, bRole = '⚔️ 输出位';
    A.DB.pets.forEach(p => {
      if (!A.squadAvail(st, p)) return;
      const trial = cur.concat([p]);
      const sc = A.scoreTeam(trial, null);
      const wc = A.weakCounts(trial);
      const maxW = Math.max.apply(null, TYPES18.map(a => wc[a]));
      const gain = sc.total + sc.parts[1].score * 0.5 - maxW * 8 + A.superCountOf(trial) * 2 +
        A.synergyBonus(p, cur) * 0.3 + (rng ? rng() * 14 : 0);
      if (gain > bs){
        bs = gain; best = p;
        bRole = A.duraOf(p) >= 430 ? '🛡️ 承伤位' : (p.stats.spe >= 110 ? '💨 高速位' :
          (Math.max(p.stats.atk, p.stats.spa) >= 115 ? '⚔️ 输出位' :
            (A.sustainSkillsOf(p).length >= 2 ? '💚 续航位' : '⚔️ 输出位')));
      }
    });
    if (!best) break;
    const wc2 = A.weakCounts(cur.concat([best]));
    const maxW2 = Math.max.apply(null, TYPES18.map(a => wc2[a]));
    A.squadAdd(st, best, bRole,
      '互补选人：补入后全队共同弱点最多只有 ' + maxW2 + ' 只重叠、打击面覆盖 ' + A.superCountOf(cur.concat([best])) +
      '/18 种属性。总和 ' + best.stats.total + '、速度 ' + best.stats.spe + '、耐久 ' + A.duraOf(best) + '。');
  }
  return st.members;
}

/* ---------------- 7. 战术池 ---------------- */
function topByTotal(pool, n){
  return pool.slice().sort((a, b) => b.stats.total - a.stats.total).slice(0, n);
}
function topGlobal(n){ return topByTotal(A.DB.pets, n); }
const TACTICS = [];
function addTac(t){ TACTICS.push(t); }

/* 本期新增：自由混搭 6 战术 */
addTac({
  key: 'firegrass', title: '火草混搭队', emoji: '🌿', tag: '混搭 · 火草互补',
  build: buildFiregrass,
  pool: () => topByTotal(A.DB.pets.filter(p => p.types.includes('火') || p.types.includes('草')), 70).concat(topGlobal(40)),
  validatePets: pets => countType(pets, '火') >= 2 && countType(pets, '草') >= 2,
  swappable: () => true,
  caveat: '草系怕的火、翼，火系自己也怕水、地——遇到水系强攻队要靠补盲位先手处理，别硬换血。',
});
addTac({
  key: 'groundfight', title: '地武混搭队', emoji: '🥋', tag: '混搭 · 地武互补',
  build: buildGroundfight,
  pool: () => topByTotal(A.DB.pets.filter(p => p.types.includes('地') || p.types.includes('武')), 70).concat(topGlobal(40)),
  validatePets: pets => countType(pets, '地') >= 2 && countType(pets, '武') >= 2,
  swappable: () => true,
  caveat: '武系的克星翼/萌/幻，地系进攻打不动，只能靠补盲位与速度线周旋；地系怕的水/草同理。',
});
addTac({
  key: 'attrition', title: '消耗控制队', emoji: '☠️', tag: '战术 · 异常消耗',
  build: buildAttrition,
  pool: () => topByTotal(A.DB.pets.filter(p => petFlagsX(p).ctrlN >= 1 || A.duraOf(p) >= 380), 70).concat(topGlobal(40)),
  validatePets: pets => {
    const appliers = pets.filter(p => petFlagsX(p).status.length >= 1).length;
    const kinds = new Set(); pets.forEach(p => petFlagsX(p).statusKinds.forEach(w => kinds.add(w)));
    const ctrlSum = pets.reduce((s, p) => s + petFlagsX(p).ctrlN, 0);
    return appliers >= 2 && pets.filter(p => A.duraOf(p) >= 380).length >= 2 && ctrlSum >= 6 && kinds.size >= 2;
  },
  swappable: () => true,
  caveat: '怕高爆发一波流和驱散：状态还没叠起来就被秒核心会断档，先手保住状态手。',
});
addTac({
  key: 'burst', title: '高速爆发队', emoji: '⚡', tag: '战术 · 高速爆发',
  build: buildBurst,
  pool: () => topByTotal(A.DB.pets.filter(p => p.stats.spe >= 90), 90),
  validatePets: pets => {
    const avgSpe = pets.reduce((s, p) => s + p.stats.spe, 0) / pets.length;
    return avgSpe >= 102 && pets.filter(p => burstOf(p) >= 130).length >= 3;
  },
  swappable: () => true,
  caveat: '玻璃大炮：全队耐久偏薄，一波没压死对面就会被反打收割，怕消耗队磨血线。',
});
addTac({
  key: 'counter', title: '联防反击队', emoji: '↩️', tag: '战术 · 联防反击',
  build: buildCounter,
  pool: () => topByTotal(A.DB.pets.filter(p => { const f = petFlagsX(p); return f.responds.length || f.entryGuard || f.growths.length || A.duraOf(p) >= 400; }), 70).concat(topGlobal(40)),
  validatePets: pets => {
    const ev = pets.filter(p => { const f = petFlagsX(p); return f.responds.length || f.entryGuard || f.growths.length; }).length;
    return ev >= 2 && pets.filter(p => A.duraOf(p) >= 400).length >= 2;
  },
  swappable: () => true,
  caveat: '主动进攻火力一般，节奏偏被动：对面不打你就没有触发——遇到纯消耗队要用输出位主动破局。',
});
addTac({
  key: 'complement', title: '属性互补队', emoji: '🧩', tag: '混搭 · 弱点互补',
  build: buildComplement,
  pool: () => topGlobal(150),
  validatePets: pets => {
    const wc = A.weakCounts(pets);
    const maxW = Math.max.apply(null, TYPES18.map(a => wc[a]));
    return maxW <= 3 && A.superCountOf(pets) >= 11;
  },
  swappable: () => true,
  caveat: '没有单一体系爆发点，打的是整体均衡——单点突破能力不如专精队，靠覆盖面和轮换磨优势。',
});
/* 第 7 期机制队（页面构建器复用） */
addTac({
  key: 'mark', title: '印记队', emoji: '🌠', tag: '机制 · 星陨印记',
  build: () => A.buildMarkSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => A.markApplyOf(p).length || A.markUseOf(p).length), 60).concat(topGlobal(40)),
  validatePets: pets => pets.some(p => A.markApplyOf(p).length) && pets.some(p => A.markUseOf(p).length),
  swappable: m => /补盲|核心输出/.test(m.role),
  caveat: '印记被驱散就断档：层数清零后要重新叠，挂印记位要轮换着续层。',
});
addTac({
  key: 'offering', title: '奉献队', emoji: '🪲', tag: '机制 · 奉献',
  build: () => A.buildOfferingSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => A.offerMakeOf(p).length || A.offerUseOf(p).length), 60).concat(topGlobal(40)),
  validatePets: pets => pets.some(p => A.offerMakeOf(p).length),
  swappable: m => /补盲|核心输出/.test(m.role),
  caveat: '奉献池要时间攒：前期是这队最弱的窗口，被高速爆发队抢节奏会很难受。',
});
addTac({
  key: 'vampire', title: '吸血队', emoji: '🧛', tag: '机制 · 吸血',
  build: () => A.buildVampireSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => A.drainOf(p).length >= 2), 80),
  validatePets: pets => pets.filter(p => A.drainOf(p).length >= 2).length >= 4,
  swappable: m => !/吸血核心/.test(m.role),
  caveat: '吸血怕一波秒杀：血还没吸回来就被带走等于白带，先处理对面最高爆发点。',
});
addTac({
  key: 'energy', title: '能量队', emoji: '🔋', tag: '机制 · 能量引擎',
  build: () => A.buildEnergySquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => A.energyFeedOf(p).length || A.displayBigMove(p, 7)), 60).concat(topGlobal(40)),
  validatePets: pets => pets.some(p => A.energyFeedOf(p).length) && pets.filter(p => A.displayBigMove(p, 7)).length >= 2,
  swappable: m => /补盲|大招手/.test(m.role),
  caveat: '能量链是命门：供能手倒下，大招手的 ★7–10 大招就只能靠自然回能硬等。',
});
addTac({
  key: 'lord', title: '首领队', emoji: '👑', tag: '首领 · 形态压制',
  build: () => A.buildLordSquad(),
  pool: () => topByTotal(A.lordPets(), 68),
  validatePets: pets => { const lp = new Set(A.lordPets().map(p => p.id)); return pets.every(p => lp.has(p.id)); },
  swappable: () => true,
  caveat: '面板虽高，但速度线参差：遇到高速队容易被先手压血，靠耐久和配合链换回来。',
});
/* 天气队 ×4（页面构建器复用） */
A.WEATHER_DEFS.forEach(w => addTac({
  key: w.id, title: w.name, emoji: w.emoji, tag: '天气 · ' + w.weather, weather: w.weather,
  build: () => A.buildWeatherSquad(w),
  pool: () => topByTotal(A.DB.pets.filter(p => p.types.includes(w.type) || A.setterEvidence(p, w) || A.beneEvidence(p, w)), 80),
  validatePets: pets => pets.some(p => A.setterEvidence(p, w)) && pets.some(p => A.beneEvidence(p, w)),
  swappable: m => !/天气手|受益/.test(m.role),
  caveat: '天气只持续 8 回合：天气手倒下或断档后受益位立刻打折，先保天气手再谈输出。',
}));
/* 基础队 ×3（页面构建器复用） */
addTac({
  key: 'fire', title: '火系队', emoji: '🔥', tag: '单系 · 火',
  build: () => A.buildFireSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => p.types.includes('火')), 62).concat(topGlobal(40)),
  validatePets: pets => countType(pets, '火') >= 3,
  swappable: m => /补盲|前排坦克/.test(m.role),
  caveat: '火系集体怕水、地：遇到水系队要靠补盲位先手点掉对面水系核心。',
});
addTac({
  key: 'speed', title: '高速队', emoji: '💨', tag: '速度线 · 先手',
  build: () => A.buildSpeedSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => p.stats.spe >= 95), 90),
  validatePets: pets => pets.filter(p => p.stats.spe >= 100).length >= 4,
  swappable: m => /补盲/.test(m.role),
  caveat: '速度换的是面板：全队偏脆，被耐久消耗队拖住会越打越亏。',
});
addTac({
  key: 'tank', title: '坦克队', emoji: '🛡️', tag: '耐久 · 续航',
  build: () => A.buildTankSquad(),
  pool: () => topByTotal(A.DB.pets.filter(p => A.duraOf(p) >= 360), 90),
  validatePets: pets => pets.filter(p => A.duraOf(p) >= 380).length >= 4 && pets.filter(p => A.sustainSkillsOf(p).length >= 1).length >= 2,
  swappable: m => /耐久输出|补盲/.test(m.role),
  caveat: '输出节奏慢：遇到印记/消耗这类同样拖回合的队，要比谁的状态先叠满。',
});

/* ---------------- 8. 优化器：扰动 + 爬山（强度优先 best-of-N） ---------------- */
function famOkWith(others, cand){
  const st = A.newSquadState();
  others.forEach(p => A.squadAdd(st, p, '', ''));
  return A.squadAvail(st, cand);
}
function teamScore(pets){ return A.scoreTeam(pets, null).total; }
function perturb(members, tac, rng){
  const out = members.slice();
  const idxs = out.map((m, i) => i).filter(i => tac.swappable(out[i]));
  const n = 1 + Math.floor(rng() * 2);
  for (let k = 0; k < n && idxs.length; k++){
    const i = idxs[Math.floor(rng() * idxs.length)];
    const others = out.filter((_, j) => j !== i).map(m => m.pet);
    const pool = tac.pool().filter(c => !others.some(p => p.id === c.id) && famOkWith(others, c));
    if (!pool.length) continue;
    pool.sort((a, b) => b.stats.total - a.stats.total);
    const cand = pool[Math.floor(rng() * Math.max(1, Math.floor(pool.length / 2)))];
    const nr = roleAfterSwap(out[i].role, cand);
    out[i] = { pet: cand, role: nr, why: genericWhy(cand, nr) };
  }
  return out;
}
function repairOverlap(members, tac, sets, rng, maxOverlap){
  /* 与某个集合重合 >maxOverlap 时，把可换位里属于该集合的成员换成集合外候选 */
  let out = members.slice();
  for (const set of sets){
    let guard = 0;
    while (out.filter(m => set.has(m.pet.id)).length > maxOverlap && guard++ < 8){
      const idx = out.findIndex(m => set.has(m.pet.id) && tac.swappable(m));
      if (idx < 0) return null;
      const others = out.filter((_, j) => j !== idx).map(m => m.pet);
      const pool = tac.pool().filter(c => !set.has(c.id) && !others.some(p => p.id === c.id) && famOkWith(others, c))
        .sort((a, b) => b.stats.total - a.stats.total).slice(0, 5);
      if (!pool.length) return null;
      const cand = pool[Math.floor(rng() * pool.length)];
      const nr = roleAfterSwap(out[idx].role, cand);
      out[idx] = { pet: cand, role: nr, why: genericWhy(cand, nr) };
    }
    if (out.filter(m => set.has(m.pet.id)).length > maxOverlap) return null;
  }
  return out;
}
function optimize(members, tac, banned){
  let cur = members.slice();
  let curScore = teamScore(cur.map(m => m.pet));
  for (let pass = 0; pass < 4; pass++){
    let improved = false;
    for (let i = 0; i < cur.length; i++){
      if (!tac.swappable(cur[i])) continue;
      const others = cur.filter((_, j) => j !== i).map(m => m.pet);
      let bestCand = null, bestScore = curScore;
      for (const cand of tac.pool()){
        if (banned && banned.has(cand.id)) continue;
        if (others.some(p => p.id === cand.id)) continue;
        if (!famOkWith(others, cand)) continue;
        const trial = others.slice(); trial.splice(i, 0, cand);
        if (!tac.validatePets(trial)) continue;
        const s = teamScore(trial);
        if (s > bestScore){ bestScore = s; bestCand = cand; }
      }
      if (bestCand){
        const nr = roleAfterSwap(cur[i].role, bestCand);
        cur[i] = { pet: bestCand, role: nr, why: genericWhy(bestCand, nr) };
        curScore = bestScore; improved = true;
      }
    }
    if (!improved) break;
  }
  return { members: cur, score: curScore };
}
const FLOOR = 58, TARGET = 60, ATTEMPTS = 10;
function buildBest(tac, seedBase, sets, maxOverlap){
  const banned = new Set();
  sets.forEach(s => s.forEach(id => banned.add(id)));
  let best = null, bestSeen = -1;
  for (let att = 0; att < ATTEMPTS; att++){
    const rng = mulberry32(seedBase + att * 7919 + tac.key.length * 131);
    let members = tac.build(rng);
    if (!members || members.length !== 6) continue;
    if (att > 0) members = perturb(members, tac, rng);
    members = repairOverlap(members, tac, sets, rng, maxOverlap);
    if (!members) continue;
    const opt = optimize(members, tac, banned);
    const pets = opt.members.map(m => m.pet);
    if (!tac.validatePets(pets)) continue;
    if (sets.some(s => pets.filter(p => s.has(p.id)).length > maxOverlap)) continue;
    const links = genLinks({ id: tac.key, weather: tac.weather || null }, opt.members);
    if (links.length < 2) continue;
    if (opt.score > bestSeen) bestSeen = opt.score;
    if (!best || opt.score > best.score) best = { members: opt.members, score: opt.score, links };
    if (best.score >= 68 && att >= 4) break;
  }
  tac._bestSeen = bestSeen;
  return best;
}

/* ---------------- 9. 展示文案（全部由真实指标生成） ---------------- */
function metOf(pets){
  const s = A.scoreTeam(pets, null);
  const wc = A.weakCounts(pets);
  const weakMax = Math.max.apply(null, TYPES18.map(a => wc[a]));
  return {
    score: s,
    superCount: s.detail.superList.length,
    weakMax,
    weakTops: TYPES18.filter(a => wc[a] === weakMax && weakMax > 0),
    avgSpe: Math.round(pets.reduce((x, p) => x + p.stats.spe, 0) / pets.length),
    avgDura: Math.round(pets.reduce((x, p) => x + A.duraOf(p), 0) / pets.length),
    avgTotal: Math.round(pets.reduce((x, p) => x + p.stats.total, 0) / pets.length),
  };
}
const INTRO = {
  firegrass: (ms, met) => '火草互补是克制表实测出来的组合：草系进攻能 ×2 反打火系的克星水、地，火系能反打草系的克星冰、虫，两系弱点互不重叠。本轮这套平均总和 ' + met.avgTotal + '，火的爆发 + 草的续航与状态，混编成一套能打能磨的队伍。',
  groundfight: (ms, met) => '地、武两系弱点集零重叠（地怕水/草/冰/武/机械，武怕翼/萌/幻），没有一种属性能同时克制两系；进攻端武系又能 ×2 反打地系的克星冰、机械。本轮这套平均总和 ' + met.avgTotal + '，剩下的水/草与翼/萌/幻短板交给补盲位堵。',
  attrition: (ms, met) => '恶心消耗的打法：状态手把中毒/灼烧/冻结/寄生层层挂上，层数型状态每回合自动结算伤害；压制位再降对面属性、抬它的能耗、驱散它的增益，耐久位站着回血——对面是站着掉血。本轮全队控制/异常条目密度与耐久（平均 ' + met.avgDura + '）都拉满，就是要把比赛拖烂。',
  burst: (ms, met) => '全员速度线拉到平均 ' + met.avgSpe + '，再配每人一招高有效威力的大招：先手一波把对面血线压进斩杀区，不给它挂状态、攒能量的回合。玻璃大炮，赢在前十回合。',
  counter: (ms, met) => '联防反击：联防位带应对触发/入场增益/受击成长证据——对面打它，它就反手挂效果、叠成长；主坦先把爆发吃下来，续航位保住血线，等对面技能交完再用反击输出收割。本轮平均耐久 ' + met.avgDura + '。',
  complement: (ms, met) => '不设体系、只算互补：选人目标函数就是让全队共同弱点最少（本轮最多 ' + met.weakMax + ' 只重叠）、抗性互相 covering、打击面覆盖达标（' + met.superCount + '/18）。本轮平均总和 ' + met.avgTotal + '，是一套没有死穴的均衡混编。',
  mark: () => '幻系挂星陨印记叠层，引爆位按层数收割——层数就是弹药，配合链里每条都有 desc 原文为据。',
  offering: () => '虫系攒奉献喂全队：奉献是全队共享的增益池，产出位轮换上场保持不断档，越拖越肥。',
  vampire: () => '跨属性吸血阵容：人人带吸血来源，边打边回，专治消耗战。',
  energy: () => '场下供能 + 蓄能王牌，把能耗 ★7–10 的大招喂到能连发——正常队伍放一次都费劲的大招，这队当常规武器用。',
  lord: (ms, met) => '六只首领形态组队，平均总和 ' + met.avgTotal + '，面板压制之外还自带配合链，不是六个散装大个子。',
  snow: () => '冬至开暴风雪，冰雪魂魄让冰系威力翻倍的天气队。',
  rain: () => '落雨铺雨天，水系在雨里吸血、减能耗、双攻翻倍。',
  sand: () => '沙涌扬起沙暴，流沙统治者在沙里加速收割。',
  thunder: () => '惊雷改天气为雷鸣，电系挂引电打连锁。',
  fire: () => '火系正面压上：输出错开物/魔侧，坦克顶前排、补盲堵短板。',
  speed: (ms, met) => '全员速度线拉满（平均 ' + met.avgSpe + '），靠先手和先制招抢回合。',
  tank: (ms, met) => '六只大肉带续航（平均耐久 ' + met.avgDura + '），把比赛拖进持久战。',
};
function makePros(tac, members, met, links){
  const pros = [];
  const parts = met.score.parts.slice().sort((a, b) => b.score - a.score);
  pros.push('最强项是' + parts[0].label + '（' + parts[0].score + ' 分）');
  if (met.superCount >= 12) pros.push('打击面覆盖 ' + met.superCount + '/18 种属性，很少有打不动的对手');
  if (links.length >= 3) pros.push('配合链 ' + links.length + ' 条：' + links[0].a + ' 的「' + links[0].via + '」→ ' + links[0].b + ' 等联动真实存在（desc 可查）');
  if (met.avgSpe >= 100) pros.push('平均速度 ' + met.avgSpe + '，先手权稳定');
  if (met.avgDura >= 430) pros.push('平均耐久（体力+双防）' + met.avgDura + '，站场与换血能力强');
  if (tac.key === 'firegrass') pros.push('火草互补经克制表验证：草反打水/地、火反打冰/虫，弱点不重叠');
  if (tac.key === 'groundfight') pros.push('地武弱点零重叠，且武系能反打地系的克星冰、机械');
  if (tac.key === 'attrition') pros.push('层数型状态每回合自动结算，拖得越久优势越大');
  if (tac.key === 'burst') pros.push('人均一招高有效威力大招，先手压血能力是全图鉴前列');
  if (tac.key === 'complement') pros.push('共同弱点最多 ' + met.weakMax + ' 只重叠，不容易被一种属性一锅端');
  return pros.slice(0, 4);
}
function makeCons(tac, members, met){
  const cons = [];
  if (met.weakTops.length && met.weakMax >= 3)
    cons.push(met.weakTops.join('、') + '系是集中弱点：全队 ' + met.weakMax + '/6 只被它 ×2 克制，遇到该系输出先用补盲位顶上');
  const parts = met.score.parts.slice().sort((a, b) => a.score - b.score);
  if (parts[0].score < 55) cons.push(parts[0].label + '偏弱（' + parts[0].score + ' 分），是四项里最短的板');
  cons.push(tac.caveat);
  return cons.slice(0, 3);
}

/* ---------------- 10. 轮换选择与主流程 ---------------- */
function readPrev(){
  try {
    const raw = fs.readFileSync(ROT_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.squads)) return j;
  } catch (e) { /* 首轮或文件损坏：按首轮处理 */ }
  return null;
}
function overlapCount(ids, set){ return ids.filter(id => set.has(id)).length; }

function main(){
  const prev = readPrev();
  const round = prev ? (prev.round || 0) + 1 : 1;
  const prevSets = prev ? prev.squads.map(s => new Set(s.members.map(m => m.id))) : [];
  const prevSquadsOut = prev ? prev.squads.map(s => s.members.map(m => m.id)) : [];
  const seedBase = hashSeed((prev ? prev.generatedAt : 'genesis') + '|' + round);
  log('第 ' + round + ' 轮生成开始（上一轮 ' + prevSets.length + ' 套，种子 ' + seedBase + '）');

  const rngOrder = mulberry32(seedBase ^ 0x9e3779b9);
  const order = TACTICS.slice();
  for (let i = order.length - 1; i > 0; i--){
    const j = Math.floor(rngOrder() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const chosen = [], notes = [];
  const NEW_KEYS = ['firegrass', 'groundfight', 'attrition', 'burst', 'counter', 'complement'];
  function pickOne(tac, maxOverlap, relaxed){
    if (chosen.some(c => c.tac.key === tac.key)) return false;
    const sets = prevSets.concat(chosen.map(c => new Set(c.ids)));
    const cand = buildBest(tac, seedBase + tac.key.length * 104729, sets, maxOverlap);
    if (!cand){ notes.push(tac.key + ': 构建未达标（bestSeen=' + tac._bestSeen + '）'); return false; }
    if (cand.score < FLOOR){ notes.push(tac.key + ': 最强版本 ' + cand.score + ' < 门槛 ' + FLOOR + '，换战术'); return false; }
    const pets = cand.members.map(m => m.pet);
    const met = metOf(pets);
    chosen.push({ tac, cand, met, ids: pets.map(p => p.id), relaxed });
    log('  入选 ' + tac.key + '（' + tac.title + '）综合 ' + cand.score + (relaxed ? ' [relaxed]' : ''));
    return true;
  }
  function tryRound(maxOverlap, relaxed){
    /* 先在新战术（自由混搭/新打法）里保底选出 1 套，再按洗牌序从全池补满 3 套 */
    for (const tac of order){
      if (chosen.length >= 1) break;
      if (NEW_KEYS.includes(tac.key)) pickOne(tac, maxOverlap, relaxed);
    }
    for (const tac of order){
      if (chosen.length >= 3) break;
      pickOne(tac, maxOverlap, relaxed);
    }
  }
  tryRound(2, false);
  if (chosen.length < 3){
    log('  常规约束下只有 ' + chosen.length + ' 套，放宽重合到 ≤3 重试其余战术');
    tryRound(3, true);
  }
  if (chosen.length < 3)
    throw new Error('本轮只能生成 ' + chosen.length + ' 套达标阵容，拒绝凑数。诊断：' + notes.join('；'));

  const now = new Date();
  const next = new Date(now.getTime() + 48 * 3600 * 1000);
  const squads = chosen.map((c, i) => {
    const introFn = INTRO[c.tac.key] || (() => c.tac.tag + '：按数据规则组出的混搭阵容。');
    const sq = {
      id: c.tac.key + '-r' + round + '-' + (i + 1),
      tactic: c.tac.key,
      title: c.tac.title,
      emoji: c.tac.emoji,
      tag: c.tac.tag,
      intro: introFn(c.cand.members, c.met),
      score: c.cand.score,
      scores: {
        total: c.met.score.total,
        parts: c.met.score.parts.map(pt => ({ key: pt.key, label: pt.label, score: pt.score })),
      },
      members: c.cand.members.map(m => ({ id: m.pet.id, name: m.pet.name, role: m.role, why: m.why })),
      links: c.cand.links,
      pros: makePros(c.tac, c.cand.members, c.met, c.cand.links),
      cons: makeCons(c.tac, c.cand.members, c.met),
    };
    if (c.relaxed) sq.relaxed = true;
    return sq;
  });
  const out = {
    round,
    generatedAt: now.toISOString(),
    nextAt: next.toISOString(),
    squads,
    prevSquads: prevSquadsOut,
  };
  fs.writeFileSync(ROT_PATH, JSON.stringify(out, null, 1) + '\n');
  log('已写入 ' + ROT_PATH + '：第 ' + round + ' 轮 3 套（' +
    squads.map(s => s.title + ' ' + s.score).join(' / ') + '），下次更新 ' + out.nextAt);
  if (notes.length) log('未入选战术诊断：' + notes.join('；'));
}
if (process.env.ROT_DIAG){
  /* 诊断模式：每个战术在无避重复约束下各构建一次，报告可达最高分 */
  for (const tac of TACTICS){
    const t0 = Date.now();
    const cand = buildBest(tac, 424242 + tac.key.length * 104729, [], 2);
    log('DIAG ' + tac.key + '（' + tac.title + '）：' + (cand ? '最高 ' + cand.score + ' 分，配合链 ' + cand.links.length + ' 条' : '构建失败') +
      '，耗时 ' + (Date.now() - t0) + 'ms');
  }
} else {
  main();
}
