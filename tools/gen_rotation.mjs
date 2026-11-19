#!/usr/bin/env node
/* ============================================================
 * roco-world 阵容轮换生成器（第 8 期）
 *
 * 用法（cron 每 48 小时调用一次，工作目录 = 仓库根目录）：
 *   node tools/gen_rotation.mjs            # 生成新一轮（自带战术手册，走第 10 期一致性管线）
 *   node tools/gen_rotation.mjs --enrich   # 只给当前轮次按一致性管线重算配合链与战术手册，成员/轮次/时间/分数不动（幂等）
 *   node tools/gen_rotation.mjs --themed   # 第 16 期：生成主题重构轮（高爆发/均衡攻防/能量经济 3 套，带能量明细与能量闸门）
 *   node tools/gen_rotation.mjs --check-energy  # 第 16 期：对现盘带 energy 的阵容复跑能量闸门
 *   ENERGY_GATE_TEST=1 node tools/gen_rotation.mjs  # 第 16 期：能量闸门破坏性自检
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
        const dst = ce.k === '特性' ? A.DB.abilityByName[ce.n] : A.skillOf(ce.n);
        /* 第 12 期：文案按双方 desc 公式写（施加段 + 消费段原文）；
           发起方带条件须注入；按层叠加的下限 desc 无明文时标待核验。 */
        const cond = A.condPhraseOf(src ? src.desc : '', sa.w);
        const useSeg = A.descSegWith(dst ? dst.desc : '', sa.w);
        const caveat = /每有1层[^。；]*-\d+%/.test(useSeg) ? '按层叠加的下限 desc 无明文，待核验。' : '';
        links.push({
          kind: 'status', a: a.name, via: sa.e.n, viaKind: sa.e.k, b: b.name,
          text: a.name + '先用' + sa.e.k + '「' + sa.e.n + '」' + (cond ? '在' + cond : '') +
            '给敌方挂上' + sa.w + '（' + A.applySegOf(src ? src.desc : '', sa.w) + '），' + b.name + '的' +
            ce.k + '「' + ce.n + '」按 desc 公式吃这个状态——' + useSeg + '。' + caveat,
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
      '状态的层数与效果都以各技能 desc 原文为准，它活得越久，能挂上的层数越多。耐久 ' + A.duraOf(ap) + '、总和 ' + ap.stats.total + '。');
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
      '——它站着回血，把回合数拖长。总和 ' + t.stats.total + '。');
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
  caveat: '印记记在被施加的那只敌方身上：消费位换目标等于重新叠层，挂印记位要盯住主攻目标续层。',
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
  caveat: '天气只持续 8 回合：窗口过后要由天气手续上，排好续天气的回合，别让受益位断档。',
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
        if (tac.banPet && tac.banPet(cand)) continue;
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
    const links0 = genLinks({ id: tac.key, weather: tac.weather || null }, opt.members);
    if (links0.length < 2) continue;
    if (opt.score > bestSeen) bestSeen = opt.score;
    /* 第 10 期：入选候选必须先过一致性管线（定配合→定配招→写手册→硬断言）；
       只对有望夺冠的候选跑完整管线，省去注定落选者的开销。断言抛错会
       直接中止整个生成（非零退出、不写文件）——那是模型 bug 的信号，
       不静默绕过；管线判不合格（剔链后 links <2 等）则跳过该候选。 */
    if (!best || opt.score > best.score){
      const fin = finalizeSquad(tac, opt.members, null, 'default');
      if (!fin) continue;
      best = { members: fin.members, score: opt.score, links: fin.links, playbook: fin.playbook };
    }
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
  attrition: (ms, met) => '恶心消耗的打法：状态手把中毒/灼烧/冻结/寄生层层挂上（层数与效果以各技能 desc 原文为准，结算方式本站不外推）；压制位再降对面属性、抬它的能耗、驱散它的增益，耐久位站着回血拖长回合。本轮全队控制/异常条目密度与耐久（平均 ' + met.avgDura + '）都拉满，就是要把比赛拖烂。',
  burst: (ms, met) => '全员速度线拉到平均 ' + met.avgSpe + '，再配每人一招高有效威力的大招：先手一波把对面血线压进斩杀区，不给它挂状态、攒能量的回合。玻璃大炮，赢在前十回合。',
  counter: (ms, met) => '联防反击：联防位带应对触发/入场增益/受击成长证据——对面打它，它就反手挂效果、叠成长；主坦先把爆发吃下来，续航位保住血线，等对面技能交完再用反击输出收割。本轮平均耐久 ' + met.avgDura + '。',
  complement: (ms, met) => '不设体系、只算互补：选人目标函数就是让全队共同弱点最少（本轮最多 ' + met.weakMax + ' 只重叠）、抗性互相 covering、打击面覆盖达标（' + met.superCount + '/18）。本轮平均总和 ' + met.avgTotal + '，是一套没有死穴的均衡混编。',
  mark: () => '幻系挂星陨印记叠层，消费位按各自 desc 公式吃层数（连击数、威力等）——层数就是弹药，配合链里每条都有 desc 原文为据。',
  offering: () => '虫系攒奉献喂全队：奉献是全队共享的增益池，产出位轮换上场持续产出（每次产出的次数与效果以各技能 desc 为准）。',
  vampire: () => '跨属性吸血阵容：人人带吸血来源，边打边回，专治消耗战。',
  energy: () => '场下供能 + 蓄能王牌，把能耗 ★7–10 的大招喂到能连发——正常队伍放一次都费劲的大招，这队当常规武器用。',
  lord: (ms, met) => '六只首领形态组队，平均总和 ' + met.avgTotal + '，面板压制之外还自带配合链，不是六个散装大个子。',
  snow: () => '冬至开暴风雪，冰雪魂魄让冰系威力翻倍的天气队。',
  rain: () => '落雨铺雨天，水系在雨里吸血、减能耗、双攻翻倍。',
  sand: () => '沙涌扬起沙暴，流沙统治者在沙里加速收割。',
  thunder: () => '惊雷改天气为雷鸣，电系挂引电打连锁。',
  fire: () => '火系正面压上：输出错开物/魔侧，坦克顶前排、补盲堵短板。',
  speed: (ms, met, mvSets) => {
    const hasPrio = (mvSets || []).some(s => [...s].some(n => {
      const d = (A.skillOf(n) || {}).desc || '';
      return (d.includes('先手+1') || d.includes('迅捷')) && !d.includes('先手-1');
    }));
    return '全员速度线拉满（平均 ' + met.avgSpe + '），靠' + (hasPrio ? '先手和先制招' : '速度线') + '抢回合。';
  },
  tank: (ms, met) => '六只大肉带续航（平均耐久 ' + met.avgDura + '），把比赛拖进持久战。',
};
function makePros(tac, members, met, links){
  const pros = [];
  const parts = met.score.parts.slice().sort((a, b) => b.score - a.score);
  pros.push('最强项是' + parts[0].label + '（' + parts[0].score + ' 分）');
  if (met.superCount >= 12) pros.push('打击面覆盖 ' + met.superCount + '/18 种属性，很少有打不动的对手');
  if (links.length >= 3) pros.push('配合链 ' + links.length + ' 条：' + links[0].a + ' 的「' + links[0].via + '」→ ' + links[0].b + ' 等核心联动' +
    (links.some(L => /待核验/.test(L.text || '')) ? '已经 desc 原文核验（含待核验子项的链已在链内注明）' : '均已经 desc 原文核验'));
  if (met.avgSpe >= 100) pros.push('平均速度 ' + met.avgSpe + '，先手权稳定');
  if (met.avgDura >= 430) pros.push('平均耐久（体力+双防）' + met.avgDura + '，站场与换血能力强');
  if (tac.key === 'firegrass') pros.push('火草互补经克制表验证：草反打水/地、火反打冰/虫，弱点不重叠');
  if (tac.key === 'groundfight') pros.push('地武弱点零重叠，且武系能反打地系的克星冰、机械');
  if (tac.key === 'attrition') pros.push('状态叠层手段多、耐久厚，拖长回合对本队有利（状态结算以各技能 desc 原文为准）');
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

/* ---------------- 9.5 战术手册（第 9 期）：起手 + 五段剧本 + 推荐配招 ----------------
 * 全部数据驱动：起手用统一打分（速度 + 开场型资源权重 + 耐久兜底），不按
 * 战术名硬编码；五段剧本模板参数化，每段点名的成员必是本队成员、引用的
 * 每个技能/特性名必属于所指精灵（与配合链同一验证口径）。
 * 第 10 期起生成顺序钉死为「先定配合 → 再定配招 → 最后写手册」（见 9.6）：
 * 配招是团队定制（关键技能锁定 + buildCard 补齐），手册只从最终配招里
 * 引用技能。生成过程无随机、无时间依赖，同一支队伍重复生成结果一致
 * （enrich 幂等的前提）。 */
function evQuote0(ev){
  /* desc 第一小句（在 。； 处截断），去尾标点后嵌入句子中段；
     摘录里的「」一律去掉括号——摘录是证据不是引用，避免其中提到的
     其它技能名被一致性断言误判为手册引用（全库仅 3 条 desc 有此情况） */
  const src = ev.k === '特性' ? A.DB.abilityByName[ev.n] : A.skillOf(ev.n);
  let d = src ? String(src.desc || '').split(/[。；]/)[0] : '';
  d = d.replace(/「/g, '').replace(/」/g, '');
  if (d.length > 42) d = d.slice(0, 42) + '…';
  return d;
}
function setterEv(pet, w){
  if (typeof A.setterEvObj === 'function') return A.setterEvObj(pet, w);
  for (const n of w.setterSkills) if (A.petHasSkill(pet, n)) return { n, k: '技能' };
  for (const n of w.setterAbilities) if (pet.ability === n) return { n, k: '特性' };
  return null;
}
function beneEv(pet, w){
  if (typeof A.beneEvObj === 'function') return A.beneEvObj(pet, w);
  for (const n of w.beneAbilities) if (pet.ability === n) return { n, k: '特性' };
  for (const n of w.beneSkills) if (A.petHasSkill(pet, n)) return { n, k: '技能' };
  return null;
}

/* 开场型资源：天气设定 / 供能 / 蓄势特性 / 状态或印记挂载 / 先手招 / 入场增益。
   蓄势与入场增益计分并写入起手理由，但不作为「第一回合动作」（蓄势要在场下攒、
   入场增益是被动），第一回合动作的优先级 = 天气 > 供能 > 挂载 > 先手 > 纯火力。 */
const RES_W = { weather: 150, feed: 80, charge: 65, setup: 55, prio: 35, guard: 30 };
function leadResources(pet, tac){
  const out = [];
  if (tac && tac.weather){
    const w = A.WEATHER_DEFS.find(x => x.weather === tac.weather);
    if (w){ const ev = setterEv(pet, w); if (ev) out.push({ kind: 'weather', ev, w }); }
  }
  const feed = A.energyFeedOf(pet)[0];
  if (feed) out.push({ kind: 'feed', ev: feed });
  else if (A.petHasSkill(pet, '假寐')) out.push({ kind: 'feed', ev: { n: '假寐', k: '技能' } });
  if (A.chargeTypeOf(pet) !== undefined) out.push({ kind: 'charge', ev: { n: pet.ability, k: '特性' } });
  const fx = petFlagsX(pet);
  if (fx.status.length) out.push({ kind: 'setup', ev: fx.status[0].e, word: fx.status[0].w });
  else { const mk = A.markApplyOf(pet)[0]; if (mk) out.push({ kind: 'setup', ev: mk, word: '星陨印记' }); }
  const pm = (typeof A.prioMoveName === 'function') ? A.prioMoveName(pet) : null;
  if (pm) out.push({ kind: 'prio', ev: { n: pm.name, k: '技能' } });
  if (fx.entryGuard) out.push({ kind: 'guard', ev: { n: pet.ability, k: '特性' } });
  return out;
}
function pickLead(members, tac){
  let best = null;
  members.forEach(m => {
    const pet = m.pet;
    const res = leadResources(pet, tac);
    let score = pet.stats.spe * 0.6 + A.duraOf(pet) * 0.06;
    res.forEach(r => { score += RES_W[r.kind] || 0; });
    if (!best || score > best.score ||
        (score === best.score && (pet.stats.spe > best.pet.stats.spe ||
         (pet.stats.spe === best.pet.stats.spe && pet.id < best.pet.id))))
      best = { pet, res, score };
  });
  return best;
}
function leadReason(leadC, members, citedRes){
  const pet = leadC.pet;
  const rank = 1 + members.filter(x => x.pet.stats.spe > pet.stats.spe).length;
  let s = pet.name + ' 起手：速度 ' + pet.stats.spe + '（全队第 ' + rank + '）';
  const cited = citedRes || leadC.res;
  if (cited.length){
    cited.slice(0, 2).forEach(r => {
      s += '，' + r.ev.k + '「' + r.ev.n + '」——' + evQuote0(r.ev);
    });
  } else {
    s += '，没有开场型资源，靠耐久（体力+双防）' + A.duraOf(pet) + ' 兜底压血线';
  }
  return s + '。';
}
/* ---------------- 9.6 一致性管线（第 10 期）：先定配合 → 再定配招 → 最后写手册 ----------------
 * 第 9 期的问题：配招（buildCard 只看个体）、配合链（squadLinks 按全技能池
 * 检测）、手册（按全技能池写剧本）三套逻辑各算各的，配合链/手册点名的
 * 关键技能常常不在推荐配招里。本期钉死顺序：
 *   1) 先算 links 与 lead，提取每只精灵的「关键技能」（优先级：① links
 *      发起技能 → ② links 受益技能 → ③ 起手理由引用技能）；某只关键技能
 *      >4 时按优先级只保留前 4，并剔除引用了被挤掉技能的 links（剔除
 *      后 links <2 ⇒ 该阵容不合格：默认模式判构建失败、enrich 报错停手）；
 *   2) 团队定制配招 = 关键技能在前 + buildCard 输出依次补齐到 4 招；
 *   3) 手册只从最终配招里挑技能引用（起手动作、收割代表招、中期轴心
 *      手段、逆风拖字诀皆然），挑不到就换轴心/换说法；
 *   4) assertSquadConsistency 硬断言（见下）：两条生成路径都执行，
 *      任一失败抛错退出且不覆盖 rotation.json。 */
function linkBeneficiaryEntries(L, members){
  /* links 受益技能提取：text 里被「」引用、属于受益者 b 的技能（自连锁
     a===b 时属于 a 本人）；属于 a 的 token 也一并纳入（超集锁定）。
     特性 token 跳过：特性固有、不占配招位。b 为「全队」时无受益技能。 */
  const byName = new Map(members.map(m => [m.pet.name, m.pet]));
  const a = byName.get(L.a) || null;
  const b = (L.b && byName.get(L.b)) || null;
  const out = [];
  const tokens = [...String(L.text || '').matchAll(/「([^」]+)」/g)].map(x => x[1]);
  tokens.forEach(t => {
    if (t === L.via) return;
    const targets = [];
    if (b && b !== a) targets.push(b);
    if (a) targets.push(a);
    for (const p of targets){
      if (!p || p.ability === t) continue;
      if (A.petHasSkill(p, t)){ out.push({ pet: p, skill: t }); break; }
    }
  });
  return out;
}
function computeKeySkills(members, links, leadC){
  const byName = new Map(members.map(m => [m.pet.name, m.pet]));
  const key = new Map(members.map(m => [m.pet.id, []]));
  const add = (pet, name) => {
    if (!pet || !name) return;
    const arr = key.get(pet.id);
    if (arr && !arr.includes(name)) arr.push(name);
  };
  links.forEach(L => {                        /* ① 发起技能 */
    if (L.viaKind === '技能') add(byName.get(L.a), L.via);
  });
  links.forEach(L => {                        /* ② 受益技能 */
    linkBeneficiaryEntries(L, members).forEach(be => add(be.pet, be.skill));
  });
  if (leadC)                                  /* ③ 起手理由引用技能（res 前两项；动作技能在 res 序内天然靠前） */
    leadC.res.slice(0, 2).forEach(r => { if (r.ev.k === '技能') add(leadC.pet, r.ev.n); });
  return key;
}
/* 精灵的血脉来源技能名 → 血脉系别（第 13 期）：与页面 petPool 的去重
   口径一致——已在等级/技能石里同名收录的技能不算血脉来源（不改血脉
   也能学，不占血脉位）。 */
function bloodNamesOf(pet){
  const map = new Map();
  A.petPool(pet).forEach(e => { if (e.src === 'blood') map.set(e.skill.name, e.bloodType); });
  return map;
}
/* 血脉关键技能择优：与 buildCard 同一标准（页面 bloodScoreOf：本系优先
   ＞ 有效威力/功能价值 ＞ 补盲 ＞ 能耗效率）；同分保留关键技能序更靠前者。 */
function bloodKeeperOf(pet, names){
  const byName = new Map(A.petPool(pet).map(e => [e.skill.name, e]));
  let best = null, bestScore = -Infinity;
  names.forEach(n => {
    const e = byName.get(n);
    const s = e ? A.bloodScoreOf(pet, e) : -Infinity;
    if (s > bestScore){ bestScore = s; best = n; }
  });
  return best;
}
function pruneLinks(members, links, leadC){
  /* 关键技能 >4 的精灵：只保留前 4，引用了被挤掉技能的 links 剔除；
     迭代到稳定。被挤掉的是起手引用技能等非 links 来源时无链可剔，
     返回 overflow=true 交调用方判不合格。
     第 13 期新增血脉互斥（游戏硬规则：每只精灵最多装备 1 个血脉技能）：
     同一精灵的关键技能里血脉来源技能 >1 时，按 bloodScoreOf 择优保留
     1 个；落选者支撑的 links 剔除并打 _blood 标记（removedBlood 计数，
     enrich 报告据此列明）；落选者若只来自起手引用（无链可剔），记入
     banned 从关键技能里直接摘除——起手文案由 buildPlaybook 按最终
     配招过滤引用，不会再点名它。buildMoveset 另有守卫兜底，任何路径
     都不许第二个血脉技能进配招；assertSquadConsistency 有断言把关。 */
  const byId = new Map(members.map(m => [m.pet.id, m.pet]));
  const byName = new Map(members.map(m => [m.pet.name, m.pet]));
  const banned = new Map();   // pid -> Set(落选血脉关键技能)
  const loggedBlood = new Set();
  let removedBlood = 0;
  let cur = links.slice();
  const removed = [];
  const applyBans = km => {
    const out = new Map();
    km.forEach((arr, pid) => {
      const b = banned.get(pid);
      out.set(pid, b ? arr.filter(n => !b.has(n)) : arr.slice());
    });
    return out;
  };
  const problemsOf = keyMap => {
    const probs = new Map();
    keyMap.forEach((arr, pid) => {
      const pet = byId.get(pid);
      const bn = bloodNamesOf(pet);
      const bloodKeys = arr.filter(n => bn.has(n));
      let excess = [], bloodExcess = [];
      if (bloodKeys.length > 1){
        const keeper = bloodKeeperOf(pet, bloodKeys);
        bloodExcess = bloodKeys.filter(n => n !== keeper);
        excess = excess.concat(bloodExcess);
      }
      if (arr.length > 4) excess = excess.concat(arr.slice(4).filter(n => !excess.includes(n)));
      if (excess.length) probs.set(pid, { excess, bloodExcess, bloodKeys });
    });
    return probs;
  };
  for (let iter = 0; iter < 10; iter++){
    const keyMap = applyBans(computeKeySkills(members, cur, leadC));
    const probs = problemsOf(keyMap);
    if (!probs.size) return { links: cur, keyMap, removed, overflow: false, removedBlood };
    probs.forEach((pr, pid) => {
      if (!pr.bloodExcess.length) return;
      const pet = byId.get(pid), bn = bloodNamesOf(pet);
      const sig = pid + '|' + pr.bloodKeys.join(',');
      if (loggedBlood.has(sig)) return;
      loggedBlood.add(sig);
      dbg('血脉互斥取舍：' + pet.name + ' 关键技能含血脉技能 ' +
        pr.bloodKeys.map(n => '「' + n + '」(' + bn.get(n) + '血脉)').join('、') +
        '，按 buildCard 同一择优标准保留其一，落选：' + pr.bloodExcess.join('、'));
    });
    const over = new Map();
    probs.forEach((pr, pid) => over.set(pid, pr.excess));
    const next = cur.filter(L => {
      const a = byName.get(L.a);
      let drop = !!(a && L.viaKind === '技能' && over.has(a.id) && over.get(a.id).includes(L.via));
      if (!drop)
        drop = linkBeneficiaryEntries(L, members)
          .some(be => over.has(be.pet.id) && over.get(be.pet.id).includes(be.skill));
      if (drop){
        let blood = false;
        const bEx = pid => { const pr = probs.get(pid); return pr ? pr.bloodExcess : []; };
        if (a && L.viaKind === '技能' && bEx(a.id).includes(L.via)) blood = true;
        if (!blood) blood = linkBeneficiaryEntries(L, members)
          .some(be => bEx(be.pet.id).includes(be.skill));
        if (blood){ L._blood = true; removedBlood++; }
        removed.push(L);
      }
      return !drop;
    });
    let progress = next.length < cur.length;
    cur = next;
    /* 剔链后仍残留的血脉落选者（只剩起手引用等非链来源）：记 banned 摘除 */
    const probs2 = problemsOf(applyBans(computeKeySkills(members, cur, leadC)));
    probs2.forEach((pr, pid) => {
      pr.bloodExcess.forEach(n => {
        if (!banned.has(pid)) banned.set(pid, new Set());
        if (!banned.get(pid).has(n)){ banned.get(pid).add(n); progress = true; }
      });
    });
    if (!progress){
      const keyMap = applyBans(computeKeySkills(members, cur, leadC));
      return { links: cur, keyMap, removed, overflow: true, removedBlood };
    }
  }
  const keyMap = applyBans(computeKeySkills(members, cur, leadC));
  return { links: cur, keyMap, removed, overflow: problemsOf(keyMap).size > 0, removedBlood };
}
/* 特性 desc 的「能耗+N」修正（第 12 期，审计 A-4）：如学院呱呱「留学生：
   全技能能耗+2」——配招展示的 ★ 必须按实际能耗显示，数据层修正并由
   moveset.energyMod 标记，页面据此加注记；断言逐招复核。 */
function energyModOf(pet){
  if (!pet.ability) return 0;
  const ab = A.DB.abilityByName[pet.ability];
  const m = ab ? String(ab.desc || '').match(/能耗\+(\d+)/) : null;
  return m ? parseInt(m[1], 10) : 0;
}
/* 特性 desc 的技能位限制（审计 A-3）：如圣剑骑士「宝剑王牌：仅可使用
   1 号和 3 号位技能」——成员打 restrictedSlot 标记，页面渲染待核验注记。 */
function restrictedSlotOf(pet){
  if (!pet.ability) return false;
  const ab = A.DB.abilityByName[pet.ability];
  return !!(ab && /仅可使用.*位技能/.test(ab.desc || ''));
}
/* 条目（{n,k}）的 desc 原文（生成器侧） */
function descOfEv(ev){
  const s = ev.k === '特性' ? A.DB.abilityByName[ev.n] : A.skillOf(ev.n);
  return s ? String(s.desc || '') : '';
}
/* 天气受益的配招口径版（第 12 期 T-4）：特性固有，或技能型受益且该技能
   已在最终配招里——技能池里有但没带上场的不算受益。 */
function beneEvIn(pet, w, set){
  for (const n of w.beneAbilities) if (pet.ability === n) return { n, k: '特性' };
  for (const n of w.beneSkills) if (set.has(n)) return { n, k: '技能' };
  return null;
}
function buildMoveset(pet, keyNames){
  /* 团队定制配招：关键技能（已按优先级排序）在前，buildCard 输出依次
     补齐（跳过已含的）；仍不足 4 招时按有效威力从技能池补满。
     energy 为展示值：带「能耗+N」特性的成员已按特性修正（见 energyModOf）。 */
  const emod = energyModOf(pet);
  const moves = [], have = new Set();
  /* 第 13 期血脉互斥守卫：关键技能锁定、buildCard 补位、技能池补满三条
     路径都经 push 收口——已有一个血脉来源技能后，其余血脉技能一律拒收。 */
  const bloodSet = bloodNamesOf(pet);
  let bloodUsed = null;
  const push = sk => {
    if (sk && !have.has(sk.name) && moves.length < 4){
      if (bloodSet.has(sk.name)){
        if (bloodUsed) return;
        bloodUsed = sk.name;
      }
      moves.push({ name: sk.name, type: sk.type, category: sk.category, power: sk.power,
        energy: sk.energy == null ? sk.energy : sk.energy + emod });
      have.add(sk.name);
    }
  };
  (keyNames || []).forEach(n => push(A.skillOf(n)));
  A.buildCard(pet).moves.forEach(mv => push(mv.skill));
  if (moves.length < 4)
    A.petSkills(pet).map(sk => ({ sk, eff: A.effPower(pet, sk) }))
      .sort((a, b) => b.eff - a.eff)
      .forEach(x => push(x.sk));
  return moves.slice(0, 4);
}

/* ---------------- 9.55 why 口径修复（第 12 期，审计 A-1/A-2/T-4） ----------------
 * members.why 在构建期按技能池口径写成（大招/真回复/控制计数/先手招都
 * 可能引用没进最终配招的技能）。配招定稿后逐条按最终配招复算：
 * 声称的招不在配招 → 换成配招内同类最优招，无则删该分句；计数与配招
 * 口径不一致 → 按配招重算，0 则删分句；天气受益声称无配招证据 → 整段
 * 降级为 genericWhy。修复后的 why 再由断言闸门复算一遍，不一致即失败。 */
function mvNameSet(moveset){ return new Set((moveset ? moveset.moves : []).map(x => x.name)); }
function sustainCountIn(pet, set){
  return A.sustainSkillsOf(pet).filter(sk => set.has(sk.name)).length;
}
function ctrlCountIn(pet, set){
  /* 与 petFlagsX.ctrlN 同口径，但技能条目只认最终配招里的（特性固有照计） */
  let n = 0;
  allEntries(pet).forEach(e => {
    if (e.k === '技能' && !set.has(e.n)) return;
    n += statusAppliedByEntry(e).length;
    if (entryHasDown(e)) n++;
    if (entryHasTax(e)) n++;
    if (entryHasDispel(e)) n++;
  });
  return n;
}
function prioMoveIn(pet, set){
  return A.petSkills(pet).filter(sk => set.has(sk.name)).find(sk => {
    const d = sk.desc || '';
    return (d.includes('先手+1') || d.includes('迅捷')) && !d.includes('先手-1');
  }) || null;
}
function repairWhy(pet, why, set){
  let w = String(why || '');
  /* A 本系大招「X」威力 P：X 必须在最终配招里 */
  w = w.replace(/本系大招「([^」]+)」威力 (\d+)/g, (m0, name) => {
    if (set.has(name)) return m0;
    let best = null;
    set.forEach(n => {
      const sk = A.skillOf(n);
      if (sk && sk.power != null && pet.types.includes(sk.type) && (sk.category === '物理' || sk.category === '魔法'))
        if (!best || sk.power > best.power) best = sk;
    });
    return best ? '本系大招「' + best.name + '」威力 ' + best.power : '';
  });
  /* E 真回复（如「X」）：例子与计数都按配招（先处理更具体的模式） */
  w = w.replace(/带 (\d+) 个真回复技能（如「([^」]+)」）/g, () => {
    const list = A.sustainSkillsOf(pet).filter(sk => set.has(sk.name));
    if (!list.length) return '';
    const heal = list.filter(sk => (sk.desc || '').includes('生命'));
    const e0 = (heal.length ? heal : list)[0];
    return '带 ' + list.length + ' 个真回复技能（如「' + e0.name + '」）';
  });
  /* B 真回复计数 */
  w = w.replace(/带 (\d+) 个真回复技能/g, () => {
    const n = sustainCountIn(pet, set);
    return n > 0 ? '带 ' + n + ' 个真回复技能' : '';
  });
  /* C 控制/异常条目计数 */
  w = w.replace(/带 (\d+) 个控制\/异常条目/g, () => {
    const n = ctrlCountIn(pet, set);
    return n > 0 ? '带 ' + n + ' 个控制/异常条目' : '';
  });
  /* D 先手/迅捷招「X」：X 必须在最终配招里 */
  w = w.replace(/，还会先手\/迅捷招「([^」]+)」，出手顺序再往前抢/g, (m0, name) => {
    if (set.has(name)) return m0;
    const pm = prioMoveIn(pet, set);
    return pm ? '，还会先手/迅捷招「' + pm.name + '」，出手顺序再往前抢' : '，靠速度线先手压血';
  });
  /* 清理删节留下的标点残渣 */
  w = w.replace(/，，+/g, '，').replace(/，(，|。)/g, '$1').replace(/：，/g, '：').replace(/（，/g, '（');
  return w;
}
function repairWhys(members, movesets, tac){
  const wDef = tac && tac.weather ? A.WEATHER_DEFS.find(x => x.weather === tac.weather) : null;
  members.forEach((m, i) => {
    const set = mvNameSet(movesets[i]);
    m.why = repairWhy(m.pet, m.why, set);
    /* F 天气受益声称：受益证据必须在最终配招/特性里（T-4） */
    if (wDef && /直接受益/.test(m.why) && !beneEvIn(m.pet, wDef, set))
      m.why = genericWhy(m.pet, m.role);
    if (restrictedSlotOf(m.pet)) m.restrictedSlot = true; else delete m.restrictedSlot;
  });
}

function buildPlaybook(tac, members, links, movesets){
  links = links || [];
  const pets = members.map(m => m.pet);
  /* 第 10 期：手册只许引用最终配招里的技能（特性固有除外）。起手打分仍
     按全技能池（pickLead 不变），但文案引用受配招约束；关键技能锁定已
     保证起手动作等关键技能必在配招里（见 9.6），这里再过滤一层兜底。 */
  const mvNames = new Map((movesets || []).map(ms => [ms.id, new Set(ms.moves.map(x => x.name))]));
  const mvList = new Map((movesets || []).map(ms => [ms.id, ms.moves]));
  const inMv = (pet, name) => mvNames.has(pet.id) && mvNames.get(pet.id).has(name);
  function bestEffMoveIn(pet){
    /* 配招内最高有效威力招；自损招（用后消耗全部生命等）不作代表招，口径同第 9 期。
       energy 取配招展示值（已含特性「能耗+N」修正，见 buildMoveset）。 */
    let best = null, be = 0, bEnergy = null;
    (mvList.get(pet.id) || []).forEach(mv => {
      const sk = A.skillOf(mv.name);
      if (!sk) return;
      if (/(消耗|失去)全部(生命|体力)|同归于尽/.test(sk.desc || '')) return;
      const e = A.effPower(pet, sk);
      if (e > be){ be = e; best = sk; bEnergy = mv.energy; }
    });
    return best ? { sk: best, eff: be, energy: bEnergy } : null;
  }
  function sustainIn(pet){
    /* 配招内的续航招（展示口径同页面 sustainExample：优先 desc 带「生命」） */
    const list = A.sustainSkillsOf(pet).filter(sk => inMv(pet, sk.name));
    if (!list.length) return null;
    const heal = list.filter(sk => (sk.desc || '').includes('生命'));
    return (heal.length ? heal : list)[0];
  }
  function sustainNIn(pet){
    return A.sustainSkillsOf(pet).filter(sk => inMv(pet, sk.name)).length;
  }
  function respondsIn(pet){
    return petFlagsX(pet).responds.filter(e => e.k === '特性' || inMv(pet, e.n));
  }
  function bigHolderIn(exclude){
    /* 大招受益者只从最终配招里找：某成员配招里真有一招 ★≥5 的才点名 */
    let best = null;
    members.forEach(m => {
      if (m.pet === exclude) return;
      (mvList.get(m.pet.id) || []).forEach(mv => {
        if (mv.power == null || (mv.energy || 0) < 5) return;
        const key = (mv.energy || 0) * 1000 + (mv.power || 0);
        if (!best || key > best.key) best = { pet: m.pet, sk: mv, key };
      });
    });
    return best;
  }
  const leadC = pickLead(members, tac);
  const lead = leadC.pet;
  const citedRes = leadC.res.filter(r => r.ev.k === '特性' || inMv(lead, r.ev.n));
  let prim = null;
  for (const k of ['weather', 'feed', 'setup', 'prio']){
    prim = citedRes.find(x => x.kind === k) || null;
    if (prim) break;
  }
  const wc = A.weakCounts(pets);
  const weakMax = Math.max.apply(null, TYPES18.map(a => wc[a]));
  const weakTops = TYPES18.filter(a => wc[a] === weakMax && weakMax > 0);

  /* ---- 中期轴心：耐久为主（任务定义），减伤/回复/应对手段是资格与加分，
          权重压住不让技能数量盖过耐久差；优先在持手段者里选。
          第 10 期：手段只认最终配招里的——手册要引用它，必须真带上场 ---- */
  function shieldIn(pet){
    return allEntries(pet).some(e => e.k === '技能' && /减伤/.test(e.desc) && inMv(pet, e.n));
  }
  function pivotScore(pet){
    return A.duraOf(pet) + Math.min(sustainNIn(pet), 2) * 25 +
      Math.min(respondsIn(pet).length, 2) * 15 + (shieldIn(pet) ? 10 : 0);
  }
  function pivotHasTools(pet){
    return sustainNIn(pet) > 0 || respondsIn(pet).length > 0 || shieldIn(pet);
  }
  const pivotPool = members.filter(m => pivotHasTools(m.pet));
  let pivot = null, pivotBest = -Infinity;
  (pivotPool.length ? pivotPool : members).forEach(m => {
    const s = pivotScore(m.pet);
    if (s > pivotBest){ pivotBest = s; pivot = m.pet; }
  });
  /* ---- 后期收割手：速度+有效威力最强（纯供能位爆发不足时让位）；
          第 10 期：爆发与代表招都只看最终配招 ---- */
  const finCands = members.map(m => {
    const bm = bestEffMoveIn(m.pet);
    const burst = bm ? bm.eff : 0;
    return { pet: m.pet, burst, score: burst + m.pet.stats.spe * 0.5 };
  }).sort((a, b) => b.score - a.score);
  let finisher = finCands[0].pet;
  for (const c of finCands){ if (c.burst >= 90){ finisher = c.pet; break; } }
  const finMove = bestEffMoveIn(finisher);
  /* ---- 残局核心：击杀收益（击败回能/回复）或吸血续航；
          引用条目必须是特性或在最终配招里 ---- */
  let residual = null;
  for (const m of members){
    const hit = allEntries(m.pet).find(e => (e.k === '特性' || inMv(m.pet, e.n)) &&
      /(击败|击杀|打倒)/.test(e.desc) && /(回复|吸血)/.test(e.desc));
    if (hit){ residual = { pet: m.pet, ev: hit, kind: 'kill' }; break; }
  }
  if (!residual){
    for (const m of members){
      const dr = A.drainOf(m.pet);
      if (dr.length < 2) continue;
      const stateEv = dr.filter(e => (e.n === '贪婪' || e.n === '等价交换' || e.k === '特性') &&
        (e.k === '特性' || inMv(m.pet, e.n)))[0];
      if (stateEv){ residual = { pet: m.pet, ev: stateEv, kind: 'drain' }; break; }
    }
  }

  const phases = [];
  /* ---- 开局 ---- */
  {
    let text;
    if (prim && prim.kind === 'weather'){
      const src = prim.ev.k === '特性' ? A.DB.abilityByName[prim.ev.n] : A.skillOf(prim.ev.n);
      const durM = src ? String(src.desc || '').match(/持续\s*(\d+)\s*回合/) : null;
      /* 第 12 期（T-4）：受益名单改配招口径——技能型受益必须在最终配招里，
         技能池里有但没带上场的不算受益（特性固有照旧）。 */
      const benes = members.filter(m => m.pet !== lead && beneEvIn(m.pet, prim.w, mvNames.get(m.pet.id) || new Set())).map(m => m.pet.name);
      text = lead.name + ' 首发，先用' + prim.ev.k + '「' + prim.ev.n + '」把天气改成' + tac.weather + '——' + evQuote0(prim.ev) + '。' +
        (benes.length
          ? benes.slice(0, 3).join('、') + ' 在' + tac.weather + '下直接受益' + (durM ? '，天气持续 ' + durM[1] + ' 回合' : '') + '，这段窗口就是本队的第一波优势期。'
          : '天气在场期间，队友轮换上场都能吃到收益，先把回合数打进天气窗口里。');
    } else if (prim && prim.kind === 'feed'){
      const big = bigHolderIn(lead);
      if (prim.ev.n === '假寐'){
        /* 第 12 期（C-1/T-5）：假寐按单次口径写——1 次奉献：能耗-2，
           不点名「受益最大的大招」这种把单次资源说成持续供能的话。 */
        text = lead.name + ' 起手先用技能「假寐」攒一份单次资源——' + evQuote0(prim.ev) + '。' +
          '这 1 次奉献的效果是能耗-2（desc 明文），留给后面最关键的一发大招；由谁消费、何时消费 desc 没有明文，待核验。' +
          '它自己同时回复 2 点能量，起手不亏节奏。';
      } else if (prim.ev.n === '加大功率'){
        text = lead.name + ' 起手用「加大功率」主动脱离——' + evQuote0(prim.ev) + '，把 8 点能量交给接棒入场的队友。' +
          (big ? '接棒优先给 ' + big.pet.name + '：它的大招「' + big.sk.name + '」（能耗 ★' + big.sk.energy + '、威力 ' + big.sk.power +
                 (/蓄力/.test((A.skillOf(big.sk.name) || {}).desc || '') ? '、蓄力招需蓄力一回合' : '') + '）吃满这 8 点能量就能提前开火。'
               : '接棒给队里能耗最高的大招位，让它提前一轮开火。');
      } else {
        text = lead.name + ' 起手先用' + prim.ev.k + '「' + prim.ev.n + '」给全队攒资源——' + evQuote0(prim.ev) + '。' +
          (big ? '受益最大的是 ' + big.pet.name + ' 的大招「' + big.sk.name + '」（能耗 ★' + big.sk.energy + '、威力 ' + big.sk.power +
                 (/蓄力/.test((A.skillOf(big.sk.name) || {}).desc || '') ? '、蓄力招需蓄力一回合' : '') + '），能量门槛一降它就能提前开火。'
               : '全队技能的能量门槛一起降低，后面几只的出手节奏都会变顺。');
      }
    } else if (prim && prim.kind === 'setup'){
      let s2 = '';
      if (prim.word === '星陨印记'){
        const consumer = members.find(m => m.pet !== lead &&
          A.markUseOf(m.pet).some(e => e.k === '特性' || inMv(m.pet, e.n)));
        if (consumer){
          const uev = A.markUseOf(consumer.pet).filter(e => e.k === '特性' || inMv(consumer.pet, e.n))[0];
          s2 = consumer.pet.name + ' 的' + uev.k + '「' + uev.n + '」按 desc 公式吃层数——' + A.descSegWith(descOfEv(uev), '星陨印记') + '，层数从第一回合就开始攒。';
        }
      } else {
        const consumer = members.find(m => m.pet !== lead &&
          petFlagsX(m.pet).consumers.some(c => c.w === prim.word && (c.e.k === '特性' || inMv(m.pet, c.e.n))));
        if (consumer){
          const ce = petFlagsX(consumer.pet).consumers
            .find(c => c.w === prim.word && (c.e.k === '特性' || inMv(consumer.pet, c.e.n))).e;
          s2 = consumer.pet.name + ' 的' + ce.k + '「' + ce.n + '」按 desc 公式吃' + prim.word + '——' + A.descSegWith(descOfEv(ce), prim.word) + '。';
        }
      }
      /* 第 12 期（T-7）：删「层数从第一回合就开始结算/每个回合都在亏血」
         这类 desc 无明文的持续伤害结算断言。 */
      text = lead.name + ' 起手先用' + prim.ev.k + '「' + prim.ev.n + '」给对面挂上' + prim.word + '——' + evQuote0(prim.ev) + '，先把层数铺起来。' +
        (s2 || '层数与效果以该技能 desc 原文为准。');
    } else if (prim && prim.kind === 'prio'){
      text = lead.name + ' 起手用先手招「' + prim.ev.n + '」抢第一波——' + evQuote0(prim.ev) + '，先把对面血线压下去。' +
        '先手压血是逼对面先交技能、先换人，本队的第一阶段配合链就能顺势展开。';
    } else {
      const bm = bestEffMoveIn(lead);
      text = (bm
        ? lead.name + ' 没有开场型资源，靠速度 ' + lead.stats.spe + ' 起手，用「' + bm.sk.name + '」（' + bm.sk.type + '系' + bm.sk.category + '、威力 ' + bm.sk.power + '、有效威力 ' + Math.round(bm.eff) + (/蓄力/.test(bm.sk.desc || '') ? '、蓄力招需蓄力一回合' : '') + '）先压一波血线。'
        : lead.name + ' 靠速度 ' + lead.stats.spe + ' 与耐久起手，先站住场再谈配合。') +
        '先把对面打疼、逼它进入本队的节奏，再让配合位上场跑链。';
    }
    phases.push({ key: 'open', title: '开局', text });
  }
  /* ---- 第一阶段：围绕配合链第 1 条（及第 2 条） ---- */
  {
    const clean = t => String(t || '').replace(/[。；]/g, '，');
    let text;
    if (links.length){
      text = '先把配合链跑通：' + links[0].a + ' 的' + links[0].viaKind + '「' + links[0].via + '」→ ' +
        (links[0].b === links[0].a ? '自身连锁' : links[0].b) + '——' + clean(links[0].text) + '。';
      if (links[1])
        text += '第二条链同步推进：' + links[1].a + ' 的' + links[1].viaKind + '「' + links[1].via + '」→ ' +
          (links[1].b === links[1].a ? '自身连锁' : links[1].b) + '——' + clean(links[1].text) + '。';
    } else {
      const other = members.find(m => m.pet !== lead) || members[0];
      const bm = bestEffMoveIn(other.pet);
      text = '本队没有成型的配合链，第一阶段就打最朴素的交换：' + lead.name + ' 先手压血，' +
        (bm ? other.pet.name + ' 用「' + bm.sk.name + '」（威力 ' + bm.sk.power + '）在侧翼补刀，把对面血线压进收割区。'
            : other.pet.name + ' 跟进补刀，把对面血线压进收割区。');
    }
    phases.push({ key: 'early', title: '第一阶段 · 建立优势', text });
  }
  /* ---- 中期：换人轴心 + 弱点联防 + 滚雪球 ---- */
  {
    const susEx = sustainIn(pivot);
    const respEx = respondsIn(pivot)[0];
    let text = pivot.name + ' 是换人轴心：耐久（体力+双防）' + A.duraOf(pivot) +
      (susEx ? '，带续航招「' + susEx.name + '」——' + evQuote0({ n: susEx.name, k: '技能' }) : '') +
      (respEx ? '，还有应对触发' + respEx.k + '「' + respEx.n + '」' : '') +
      '，血线吃紧或要拖回合时换它上场站住。';
    /* 第 12 期（T-8）：轴心若正被全队最大威胁 ×2 克制，文案必须注明风险 */
    if (weakTops.length && A.typeMult(weakTops[0], pivot.types) >= 2){
      text += '注意：' + pivot.name + ' 本人也被 ' + weakTops[0] + ' 系 ×2 克制，对 ' + weakTops[0] +
        ' 系输出别拿它当轴心硬顶，改走下面的联防/反打方案。';
    }
    if (weakTops.length){
      const T = weakTops[0];
      const resister = members.filter(m => A.typeMult(T, m.pet.types) < 1)
        .sort((a, b) => A.duraOf(b.pet) - A.duraOf(a.pet))[0];
      if (resister){
        text += '全队最怕 ' + T + ' 系（' + weakMax + ' 只被 ×2 克制），联防答案是 ' + resister.pet.name + '：' +
          T + ' 系打它只有 ×' + A.typeMult(T, resister.pet.types) + '，对面用 ' + T + ' 系进攻时就换它顶。';
      } else {
        const anti = members.find(m => A.petAtkTypes(m.pet).some(t => A.typeMult(t, [T]) >= 2));
        if (anti){
          const t = A.petAtkTypes(anti.pet).find(x => A.typeMult(x, [T]) >= 2);
          text += '全队最怕 ' + T + ' 系（' + weakMax + ' 只被 ×2 克制）且没人能抗，就用 ' + anti.pet.name + ' 的 ' + t +
            ' 系进攻反打——' + t + ' 系 ×2 克制 ' + T + ' 系，先手点掉对面的 ' + T + ' 系输出。';
        } else {
          const fast = members.slice().sort((a, b) => b.pet.stats.spe - a.pet.stats.spe)[0];
          text += '全队最怕 ' + T + ' 系（' + weakMax + ' 只被 ×2 克制），没人能抗也没有反打属性，靠 ' + fast.pet.name +
            ' 的速度 ' + fast.pet.stats.spe + ' 先手处理对面的 ' + T + ' 系输出，别让它舒服出手。';
        }
      }
    }
    const snow = links.find(L => L.kind === 'mark') || links.find(L => L.kind === 'energy') ||
      links.find(L => L.kind === 'charge') || links.find(L => L.kind === 'offering') || links.find(L => L.kind === 'weather');
    if (snow){
      if (snow.kind === 'mark') text += '雪球在印记链上：' + snow.a + ' 继续叠层、' + snow.b + ' 按 desc 公式吃层数，层数攒得越高收益越大（公式见配合链）。';
      else if (snow.kind === 'energy'){
        /* 第 12 期（T-5）：「一发接一发」类断言须 ≥2 个独立供能源；
           单次/脱离型（加大功率）按真实节奏写。 */
        let feedSrc = 0;
        members.forEach(m => {
          (mvList.get(m.pet.id) || []).forEach(mv => {
            if (['富养化', '养分回流', '加大功率', '假寐'].includes(mv.name)) feedSrc++;
          });
        });
        if (feedSrc >= 2) text += '雪球在能量链上：队里有 ' + feedSrc + ' 个独立供能源轮着补，' + snow.b + ' 的大招能一发接一发。';
        else if (snow.via === '加大功率') text += '雪球在能量链上：' + snow.a + ' 脱离时给接棒者补 8 点能量，关键回合靠这一发把 ' + snow.b + ' 的大招提前抬出来——它要脱离才触发，省着用。';
        else text += '雪球在能量链上：' + snow.a + ' 的供能是关键回合的补给，攒到 ' + snow.b + ' 的大招能提前开火时再交。';
      }
      else if (snow.kind === 'charge') text += '雪球在蓄势上：' + snow.a + ' 在场下把状态蓄满，入场那一波就是中期最强的爆发点。';
      else if (snow.kind === 'offering'){
        if (/获得1次奉献/.test(descOfEv({ n: snow.via, k: snow.viaKind })))
          text += '奉献是单次资源：' + snow.a + ' 的「' + snow.via + '」产出的那 1 次能耗-2 别乱花，留给中期最关键的一发大招。';
        else text += '雪球在奉献池上：' + snow.a + ' 持续产出、全队共享（每次产出的次数与效果以其 desc 为准）。';
      }
      else text += '中期注意天气回合：窗口过半就要考虑让 ' + snow.a + ' 续上天气，别让 ' + snow.b + ' 的受益断档。';
    }
    phases.push({ key: 'mid', title: '中期 · 扩大优势', text });
  }
  /* ---- 后期：收割 ---- */
  {
    /* 第 12 期（T-6）：代表招带「蓄力」时文案必须带前置提示；若其配招里
       有免蓄力手段（如「架势」下次技能无需蓄力）一并点明。 */
    let chargeNote = '';
    if (finMove && /蓄力/.test(finMove.sk.desc || '')){
      const freeCharge = (mvList.get(finisher.id) || []).map(x => A.skillOf(x.name))
        .find(sk => sk && /无需蓄力|免蓄力/.test(sk.desc || ''));
      chargeNote = '，注意它是蓄力招，需蓄力一回合才能出手' +
        (freeCharge ? '，它带的「' + freeCharge.name + '」能让下次技能无需蓄力（desc 原文），留给收割那一发' : '') +
        '，收割要提前一回合铺垫';
    }
    let text = finMove
      ? '收割交给 ' + finisher.name + '：速度 ' + finisher.stats.spe + '，最大招「' + finMove.sk.name + '」（' +
        finMove.sk.type + '系' + finMove.sk.category + '、威力 ' + finMove.sk.power + '、能耗 ★' + (finMove.energy != null ? finMove.energy : finMove.sk.energy) +
        '、有效威力 ' + Math.round(finMove.eff) + '）' + chargeNote + '，' +
        (finisher.stats.spe >= 100 ? '对面残血时它先手点名，一只一只带走。' : '对面残血时它一招一个，一只一只带走。')
      : '收割交给 ' + finisher.name + '：速度 ' + finisher.stats.spe + '，靠速度线逐个点名残血。';
    if (residual){
      const same = residual.pet === finisher;
      if (residual.kind === 'kill')
        text += (same ? residual.pet.name + ' 同时是残局核心：' : '残局核心是 ' + residual.pet.name + '：') +
          residual.ev.k + '「' + residual.ev.n + '」带击杀收益——' + evQuote0(residual.ev) + '，残局每收掉一只都能把收益滚起来。';
      else
        text += (same ? residual.pet.name + ' 同时是残局核心：' : '残局核心是 ' + residual.pet.name + '：') +
          residual.ev.k + '「' + residual.ev.n + '」挂上吸血后边打边回——' + evQuote0(residual.ev) + '，残局换血它占便宜。';
    } else {
      text += '本队没有击杀收益型效果，残局就靠 ' + finisher.name + ' 的速度线逐个收割，优先点掉对面最快的，别给它翻盘的回合。';
    }
    phases.push({ key: 'late', title: '后期 · 收割', text });
  }
  /* ---- 逆风局 ---- */
  {
    const leadWeak = TYPES18.filter(a => A.typeMult(a, lead.types) > 1);
    /* 第 12 期（T-1/T-2/T-3）：顶替者必须过相性校验——对 lead 的全部弱点
       属性都不被 ×2 克制才算合格；找不到合格者时如实写没人能硬顶，
       不许点名一个同被 ×2 克制的成员去顶。续航按最终配招计（sustainIn）。 */
    const qualified = [], unqualified = [];
    members.forEach(m => {
      if (m.pet === lead) return;
      const worst = leadWeak.length ? Math.max.apply(null, leadWeak.map(t => A.typeMult(t, m.pet.types))) : 0;
      const resisted = leadWeak.filter(t => A.typeMult(t, m.pet.types) < 1);
      const rec = { pet: m.pet, worst, resisted,
        score: resisted.length * 40 + A.duraOf(m.pet) * 0.1 + (sustainIn(m.pet) ? 25 : 0) };
      (worst < 2 ? qualified : unqualified).push(rec);
    });
    qualified.sort((a, b) => b.score - a.score);
    unqualified.sort((a, b) => (a.worst - b.worst) || (b.score - a.score));
    let text;
    if (leadWeak.length && qualified.length){
      const sub = qualified[0].pet, subResisted = qualified[0].resisted;
      const subSus = sustainIn(sub);
      text = '若首发 ' + lead.name + '（' + lead.types.join('/') + ' 系）被对面 ' + leadWeak.join('、') +
        ' 系克制，别硬打：换 ' + sub.name + ' 顶上——' +
        (subResisted.length
          ? '它对 ' + subResisted.join('、') + ' 系有抗性（' + subResisted[0] + ' 系打它只有 ×' + A.typeMult(subResisted[0], sub.types) + '），且这组属性没有一项能 ×2 克制它'
          : '这组属性没有一项能 ×2 克制它（倍率最高 ×' + qualified[0].worst + '）') +
        (subSus ? '，带续航招「' + subSus.name + '」能站场回血' : '') + '，先把节奏稳住。';
    } else if (leadWeak.length){
      const sub = unqualified[0].pet;
      const subSus = sustainIn(sub);
      text = '若首发 ' + lead.name + '（' + lead.types.join('/') + ' 系）被对面 ' + leadWeak.join('、') +
        ' 系克制，先说实话：这组属性本队没人能硬顶（每只至少被其中一系 ×2）。相对最稳的是 ' + sub.name +
        '（对这组属性倍率最高 ×' + unqualified[0].worst + '、耐久 ' + A.duraOf(sub) + '）' +
        (subSus ? '，带续航招「' + subSus.name + '」' : '') +
        '，先换它靠耐久' + (subSus ? '和回血' : '') + '拖住回合，别指望靠换人解掉克制。';
    } else {
      const sub = (qualified[0] || unqualified[0]).pet;
      const subSus = sustainIn(sub);
      text = lead.name + ' 没有被 ×2 克制的属性，逆风主要来自速度被压：被先手压血时换 ' + sub.name + ' 顶上——耐久 ' +
        A.duraOf(sub) + (subSus ? '，带续航招「' + subSus.name + '」能站场回血' : '') + '，先把节奏稳住。';
    }
    /* 拖字诀资源：降属性 → 能耗压制 → 挂状态 → 回复，取第一个真实存在的；
       第 10 期：只认特性或最终配招里的条目，配招外的一律跳过 */
    let drag = null;
    const citable = (pet, e) => e && (e.k === '特性' || inMv(pet, e.n));
    for (const m of members){ const e = petFlagsX(m.pet).downs.find(x => citable(m.pet, x)); if (e){ drag = { pet: m.pet, ev: e, mode: 'down' }; break; } }
    if (!drag) for (const m of members){ const e = petFlagsX(m.pet).taxes.find(x => citable(m.pet, x)); if (e){ drag = { pet: m.pet, ev: e, mode: 'tax' }; break; } }
    if (!drag) for (const m of members){ const s0 = petFlagsX(m.pet).status.find(x => citable(m.pet, x.e)); if (s0){ drag = { pet: m.pet, ev: s0.e, mode: 'status', word: s0.w }; break; } }
    if (!drag) for (const m of members){ const s0 = sustainIn(m.pet); if (s0){ drag = { pet: m.pet, ev: { n: s0.name, k: '技能' }, mode: 'heal' }; break; } }
    if (drag){
      if (drag.mode === 'status')
        text += '拖字诀靠 ' + drag.pet.name + ' 的' + drag.ev.k + '「' + drag.ev.n + '」挂上' + drag.word + '——' + evQuote0(drag.ev) + '，先把对面的节奏拖慢（状态的结算方式以各技能 desc 原文为准）。';
      else if (drag.mode === 'heal')
        text += '拖字诀靠 ' + drag.pet.name + ' 的「' + drag.ev.n + '」回血站场，把回合数拖到配合链攒满。';
      else
        text += '拖字诀靠 ' + drag.pet.name + ' 的' + drag.ev.k + '「' + drag.ev.n + '」——' + evQuote0(drag.ev) + '，先把对面的节奏拖慢。';
    }
    const flipKinds = ['mark', 'energy', 'charge', 'weather', 'offering', 'drain', 'status', 'heal'];
    let flip = null;
    for (const k of flipKinds){ flip = links.find(L => L.kind === k); if (flip) break; }
    if (flip && flip.kind === 'offering' && /获得1次奉献/.test(descOfEv({ n: flip.via, k: flip.viaKind })))
      text += '翻盘点在那份单次奉献：' + flip.a + ' 的「' + flip.via + '」产出的能耗-2 留给收割手的关键一发，别提前花掉。';
    else if (flip && flip.via === '加大功率')
      text += '翻盘点在配合链：' + flip.a + ' 的技能「加大功率」→ ' + flip.b + '——它脱离补的那 8 点能量，就是反打的信号。';
    else if (flip)
      text += '翻盘点在配合链：' + flip.a + ' 的' + flip.viaKind + '「' + flip.via + '」→ ' +
        (flip.b === flip.a ? '自身连锁' : flip.b) + '，这条链攒满、跑通的那一波，就是反打的信号。';
    else if (finMove)
      text += '翻盘点在 ' + finisher.name + ' 的大招「' + finMove.sk.name + '」：能量攒满后一波反打，别提前交掉' +
        (/蓄力/.test(finMove.sk.desc || '') ? '（它是蓄力招，需蓄力一回合，提前一回合开始铺垫）' : '') + '。';
    phases.push({ key: 'comeback', title: '逆风局 · 调整', text });
  }

  return {
    lead: { id: lead.id, name: lead.name, reason: leadReason(leadC, members, citedRes) },
    phases,
    movesets,
  };
}
/* ---------------- 9.7 一致性硬断言 + 管线收口（第 10 期） ----------------
 * assertSquadConsistency：逐套逐条验——
 *   - movesets 每只恰 4 招、不重复、全部 ∈ 该精灵 learnset；
 *   - movesets 每只 bloodline 来源技能 ≤1（第 13 期血脉互斥，游戏硬规则）；
 *   - links 发起技能 ∈ 发起者配招（特性 = 其 ability）；
 *   - links 受益技能（技能型）∈ 受益者配招；
 *   - playbook 全部文本（lead.reason + 五段）按句切分：句中每个被「」
 *     引用且是技能/特性的名字，必须属于该句点名的成员（技能 ∈ 其配招、
 *     特性 = 其 ability）；句中没点名成员时按全队口径验。
 * 任一失败抛错：调用方（默认生成 / enrich）随之非零退出且不写文件。 */
function assertSquadConsistency(sqLike, members, tacKey){
  const errs = [];
  const pets = members.map(m => m.pet);
  const byName = new Map(pets.map(p => [p.name, p]));
  const byId = new Map(pets.map(p => [p.id, p]));
  const pb = sqLike.playbook;
  const mvMap = new Map();
  if (!pb) errs.push('缺 playbook');
  else {
    if (!pb.lead || !byId.has(pb.lead.id)) errs.push('lead 不在队里');
    if (!Array.isArray(pb.phases) || pb.phases.length !== 5) errs.push('剧本不是 5 段');
    if (!Array.isArray(pb.movesets) || pb.movesets.length !== 6) errs.push('movesets 不是 6 行');
    (pb.movesets || []).forEach(ms => {
      const pet = byId.get(ms.id);
      if (!pet){ errs.push('moveset 成员 id=' + ms.id + ' 不在队里'); return; }
      const names = (ms.moves || []).map(x => x.name);
      if (names.length !== 4) errs.push(pet.name + ' 配招不是 4 招（实际 ' + names.length + '）');
      if (new Set(names).size !== names.length) errs.push(pet.name + ' 配招有重复');
      names.forEach(n => { if (!A.petHasSkill(pet, n)) errs.push(pet.name + ' 配招「' + n + '」不在 learnset 里'); });
      /* 第 13 期血脉互斥断言：每只配招里 bloodline 来源技能 ≤1（游戏硬规则） */
      const bn13 = bloodNamesOf(pet);
      const bc13 = names.filter(n => bn13.has(n));
      if (bc13.length > 1)
        errs.push(pet.name + ' 配招含 ' + bc13.length + ' 个血脉技能（' + bc13.join('、') +
          '），违反血脉互斥：每只精灵最多装备 1 个血脉技能（第 13 期）');
      mvMap.set(pet.id, new Set(names));
    });
  }
  const inMoves = (pet, name) => mvMap.has(pet.id) && mvMap.get(pet.id).has(name);
  (sqLike.links || []).forEach(L => {
    const a = byName.get(L.a);
    if (!a){ errs.push('配合链发起者「' + L.a + '」不在队里'); return; }
    if (L.viaKind === '技能' && !inMoves(a, L.via))
      errs.push('配合链发起技能「' + L.via + '」不在 ' + L.a + ' 的配招里');
    if (L.viaKind === '特性' && a.ability !== L.via)
      errs.push('配合链发起特性「' + L.via + '」不是 ' + L.a + ' 的特性');
    linkBeneficiaryEntries(L, members).forEach(be => {
      if (!inMoves(be.pet, be.skill))
        errs.push('配合链受益技能「' + be.skill + '」不在 ' + be.pet.name + ' 的配招里');
    });
  });
  if (pb){
    const texts = [pb.lead && pb.lead.reason].concat((pb.phases || []).map(p => p.text)).filter(Boolean);
    texts.forEach(tx => {
      String(tx).split(/[。；]/).forEach(sent => {
        if (!sent) return;
        const named = pets.filter(p => sent.includes(p.name));
        const scope = named.length ? named : pets;
        [...sent.matchAll(/「([^」]+)」/g)].forEach(mt => {
          const t = mt[1];
          const isSkill = !!A.skillOf(t);
          const isTrait = !!(A.DB.abilityByName && A.DB.abilityByName[t]);
          if (!isSkill && !isTrait) return;
          const ok = scope.some(p => (isSkill && inMoves(p, t)) || (isTrait && p.ability === t));
          if (!ok) errs.push('手册引用「' + t + '」不属于句中成员的配招/特性（句首：' + sent.slice(0, 30) + '…）');
        });
      });
    });
  }
  /* ================= 第 12 期语义闸门（审计闸门） =================
   * 效果语义级检查：文案声称必须能落到 desc 原文 / 克制表 / 最终配招，
   * 任一不过 → 抛错、非零退出、不写文件（默认与 --enrich 都执行）。 */
  /* 能耗修正（A-4）：带「能耗+N」特性的成员，配招每招展示能耗必须
     = 基础值 + N，且 moveset 必须带 energyMod 标记 */
  if (pb) (pb.movesets || []).forEach(ms => {
    const pet = byId.get(ms.id);
    if (!pet) return;
    const em = energyModOf(pet);
    if (em && ms.energyMod !== em)
      errs.push(pet.name + ' 带能耗+' + em + ' 特性，但 moveset 缺 energyMod 标记（A-4）');
    if (!em && ms.energyMod)
      errs.push(pet.name + ' 没有能耗修正特性，却带了 energyMod 标记');
    (ms.moves || []).forEach(mv => {
      const sk = A.skillOf(mv.name);
      if (sk && sk.energy != null && mv.energy !== sk.energy + em)
        errs.push(pet.name + ' 配招「' + mv.name + '」展示能耗 ' + mv.energy + ' ≠ 基础 ' + sk.energy + ' + 特性修正 ' + em + '（A-4）');
    });
  });
  /* 配合链语义 */
  const COND_KW = { mark: '星陨印记', offering: '奉献', energy: '能量', weather: '天气', drain: '吸血' };
  const offerSrcCount = {};
  (sqLike.links || []).forEach(L => {
    const txt = String(L.text || '');
    const aDesc = descOfEv({ n: L.via, k: L.viaKind });
    /* 引爆：消费者 desc 无消耗/引爆语义不许写引爆（S-2） */
    if (/引爆/.test(txt)){
      let consDesc = '';
      linkBeneficiaryEntries(L, members).forEach(be => { consDesc += descOfEv({ n: be.skill, k: '技能' }); });
      if (!/(消耗|引爆)/.test(consDesc))
        errs.push('配合链文案含「引爆」但消费者 desc 无消耗/引爆语义（' + L.a + '「' + L.via + '」→' + L.b + '）');
    }
    /* 条件：发起 desc 带触发条件，文案必须带条件短语（S-3） */
    const kw = L.kind === 'status'
      ? ((txt.match(/挂上(中毒|灼烧|冻结|寄生)/) || [])[1] || null)
      : (COND_KW[L.kind] || null);
    if (kw && A.condPhraseOf){
      const cond = A.condPhraseOf(aDesc, kw);
      if (cond){
        const key = cond.startsWith('应对') ? '应对' : (cond.startsWith('天气为') ? '天气为' : cond.replace(/时$/, ''));
        if (!txt.includes(key))
          errs.push('配合链「' + L.via + '」desc 带条件（' + cond + '），文案未注明条件');
      }
    }
    /* 奉献（C-0/C-1）：消费链受益技能 desc 必须明文奉献；单次型来源消费链 ≤1 */
    if (L.kind === 'offering' && L.b && L.b !== '全队'){
      const b = byName.get(L.b);
      const okUse = b ? A.offerUseOf(b).some(e => /奉献/.test(descOfEv(e))) : false;
      if (!okUse) errs.push('奉献消费链受益方 ' + L.b + ' 没有 desc 明文「会受奉献影响」的技能');
      if (/获得1次奉献/.test(aDesc)){
        const k = L.a + '|' + L.via;
        offerSrcCount[k] = (offerSrcCount[k] || 0) + 1;
        if (offerSrcCount[k] > 1) errs.push('单次奉献来源 ' + L.a + '「' + L.via + '」生成了多条消费链');
      }
    }
  });
  /* why 计数口径（A-1）：与配招复算不一致 → 失败 */
  members.forEach((m, i) => {
    const set = mvMap.get(m.pet.id) || new Set();
    const w = m.why || '';
    let mm;
    if ((mm = w.match(/带 (\d+) 个真回复技能/)) && parseInt(mm[1], 10) !== sustainCountIn(m.pet, set))
      errs.push(m.pet.name + ' why 的真回复计数与配招口径不一致（文案 ' + mm[1] + ' vs 配招 ' + sustainCountIn(m.pet, set) + '）');
    if ((mm = w.match(/带 (\d+) 个控制\/异常条目/)) && parseInt(mm[1], 10) !== ctrlCountIn(m.pet, set))
      errs.push(m.pet.name + ' why 的控制/异常条目计数与配招口径不一致（文案 ' + mm[1] + ' vs 配招 ' + ctrlCountIn(m.pet, set) + '）');
    if ((mm = w.match(/本系大招「([^」]+)」/)) && !set.has(mm[1]))
      errs.push(m.pet.name + ' why 的本系大招「' + mm[1] + '」不在其配招里（A-1）');
    if ((mm = w.match(/先手\/迅捷招「([^」]+)」/)) && !set.has(mm[1]))
      errs.push(m.pet.name + ' why 的先手招「' + mm[1] + '」不在其配招里（A-1）');
  });
  /* 天气受益口径（T-4）：why / 开局段声称的受益者，配招+特性须有天气引用 */
  const wDef = tacKey ? (A.WEATHER_DEFS.find(x => x.id === tacKey) || null) : null;
  if (wDef){
    members.forEach(m => {
      if (/直接受益/.test(m.why || '') &&
          !beneEvIn(m.pet, wDef, mvMap.get(m.pet.id) || new Set()))
        errs.push(m.pet.name + ' 的 why 声称' + wDef.weather + '受益，但其配招+特性无该天气引用（T-4）');
    });
    if (pb){
      const open = (pb.phases || []).find(p => p.key === 'open');
      if (open){
        const mm = open.text.match(/。([^。]+?) 在[^，。]+下直接受益/);
        if (mm) mm[1].split('、').forEach(nm => {
          const p = byName.get(nm.trim());
          if (!p){ errs.push('开局段点名的受益者「' + nm + '」不在队里'); return; }
          if (!beneEvIn(p, wDef, mvMap.get(p.id) || new Set()))
            errs.push('开局段声称 ' + p.name + ' 在' + wDef.weather + '下受益，但其配招+特性无该天气引用（T-4）');
        });
      }
    }
  }
  /* intro：声称先制招则全队配招须真有先手/迅捷招 */
  if (sqLike.intro && /先制招/.test(sqLike.intro)){
    const anyPrio = members.some(m => prioMoveIn(m.pet, mvMap.get(m.pet.id) || new Set()));
    if (!anyPrio) errs.push('intro 声称靠先制招，但全队配招里没有任何先手/迅捷招');
  }
  if (pb){
    /* 逆风顶替者相性（T-1）：「换 X 顶上」的 X 不得被 lead 弱点 ×2；
       「它对 X 系有抗性」的声称逐项与克制表核对 */
    const cb = (pb.phases || []).find(p => p.key === 'comeback');
    const lead = byId.get(pb.lead.id);
    if (cb && lead){
      const leadWeak = TYPES18.filter(a => A.typeMult(a, lead.types) > 1);
      const mTop = cb.text.match(/换\s*(\S+?)\s*顶上/);
      if (mTop){
        const sub = byName.get(mTop[1]);
        if (!sub) errs.push('逆风段顶替者「' + mTop[1] + '」不在队里');
        else {
          if (leadWeak.some(t => A.typeMult(t, sub.types) >= 2))
            errs.push('逆风段顶替者 ' + sub.name + ' 被 lead 弱点属性 ×2 克制（T-1）');
          const mRes = cb.text.match(/它对\s*(\S+?)\s*系有抗性/);
          if (mRes) mRes[1].split('、').forEach(t => {
            if (!(A.typeMult(t, sub.types) < 1))
              errs.push('逆风段声称 ' + sub.name + ' 抗 ' + t + ' 系，与克制表不符');
          });
        }
      }
    }
    /* 中期轴心风险（T-8）：轴心被全队最大威胁 ×2 时文案须注明 */
    const mid = (pb.phases || []).find(p => p.key === 'mid');
    if (mid){
      const mPiv = mid.text.match(/(\S+)\s*是换人轴心/);
      if (mPiv){
        const piv = byName.get(mPiv[1]);
        const wc2 = A.weakCounts(pets);
        const wMax = Math.max.apply(null, TYPES18.map(a => wc2[a]));
        const wTops = TYPES18.filter(a => wc2[a] === wMax && wMax > 0);
        if (piv && wTops.length && A.typeMult(wTops[0], piv.types) >= 2 &&
            !(mid.text.includes('也被') && mid.text.includes(wTops[0])))
          errs.push('中期轴心 ' + piv.name + ' 被全队最大威胁 ' + wTops[0] + ' 系 ×2 克制却未注明风险（T-8）');
      }
      /* 供能断言（T-5）：「一发接一发」须 ≥2 个独立供能源 */
      if (/一发接一发/.test(mid.text) || /供能不停/.test(mid.text)){
        let src = 0;
        members.forEach(m => {
          (mvMap.get(m.pet.id) || new Set()).forEach(n => {
            if (['富养化', '养分回流', '加大功率', '假寐'].includes(n)) src++;
          });
        });
        if (src < 2) errs.push('中期段声称供能循环（一发接一发），但全队配招里独立供能源只有 ' + src + ' 个（T-5）');
      }
    }
    /* 蓄力（T-6）：手册/配合链逐句——引用蓄力招的句子必须含「蓄力」 */
    const chargeCheck = (text, where) => {
      String(text || '').split(/[。；]/).forEach(sent => {
        [...sent.matchAll(/「([^」]+)」/g)].forEach(mt => {
          const sk = A.skillOf(mt[1]);
          if (sk && /蓄力/.test(sk.desc || '') && !sent.includes('蓄力'))
            errs.push(where + '引用蓄力招「' + mt[1] + '」却未注明蓄力（T-6）');
        });
      });
    };
    (sqLike.links || []).forEach(L => chargeCheck(L.text, '配合链'));
    chargeCheck(pb.lead.reason, '手册');
    (pb.phases || []).forEach(p => chargeCheck(p.text, '手册'));
  }
  /* 持续伤害结算黑名单（T-7）：desc 无明文的结算断言一律不许出现 */
  {
    const allTexts = [];
    (sqLike.links || []).forEach(L => allTexts.push(L.text));
    members.forEach(m => allTexts.push(m.why));
    if (sqLike.intro) allTexts.push(sqLike.intro);
    (sqLike.pros || []).forEach(t => allTexts.push(t));
    if (pb){ allTexts.push(pb.lead.reason); (pb.phases || []).forEach(p => allTexts.push(p.text)); }
    ['每回合都在结算', '每回合自动结算', '拖得越久对面掉得越多', '站着掉血'].forEach(bad => {
      if (allTexts.some(t => String(t || '').includes(bad)))
        errs.push('文案含无 desc 依据的持续伤害结算断言：' + bad + '（T-7）');
    });
  }
  if (errs.length)
    throw new Error('一致性断言失败（' + (tacKey || '?') + '）：' + errs.join('；'));
}
/* finalizeSquad：一套阵容的收口管线（9.6 顺序）——算 lead 与关键技能 →
   必要时剔链 → 定制配招 → 写手册 → 跑硬断言。
   mode='default'：不合格（剔链后 links <2 或关键技能仍 >4）返回 null；
   mode='enrich'：不合格直接抛错停手（不静默写文件），剔除的 links
   通过 removedLinks 返回给调用方报告。 */
function finalizeSquad(tac, members, existingLinks, mode){
  const leadC = pickLead(members, tac);
  const rawLinks = existingLinks ? existingLinks.slice()
    : genLinks({ id: tac.key, weather: tac.weather || null }, members);
  const pr = pruneLinks(members, rawLinks, leadC);
  if (pr.overflow || pr.links.length < 2){
    /* 第 13 期例外：enrich 存量修复时，若剔链全部由血脉互斥引起（游戏
       硬规则）且仍剩 ≥1 条链，阵容本身合法——链数 ≥2 是新阵容构建的
       质量线，不适用于被硬规则强制剔链的存量阵容——放行并在此明示；
       其余情况（overflow、非血脉原因剔到 <2、剔到 0 条）维持第 10 期
       规则：enrich 报错停手、默认模式判不合格。 */
    const bloodOnly = mode === 'enrich' && !pr.overflow && pr.links.length >= 1 &&
      pr.removed.length > 0 && pr.removed.every(L => L._blood);
    if (bloodOnly){
      log('enrich 注意：' + tac.key + ' 因血脉互斥剔链后只剩 ' + pr.links.length +
        ' 条配合链（剔除 ' + pr.removed.length + ' 条均由血脉互斥引起），按第 13 期规则放行并在此明示');
    } else if (mode === 'enrich'){
      throw new Error('enrich 中止：' + tac.key + ' 关键技能超限剔链后配合链只剩 ' + pr.links.length +
        ' 条（overflow=' + pr.overflow + '），按第 10 期规则报错停手、不写文件');
    } else return null;
  }
  const movesets = members.map(m => {
    const ms = {
      id: m.pet.id, name: m.pet.name,
      moves: buildMoveset(m.pet, pr.keyMap.get(m.pet.id) || []),
    };
    const em = energyModOf(m.pet);
    if (em) ms.energyMod = em;
    return ms;
  });
  /* 第 12 期：配招定稿后、写手册前，把 why 修到配招口径并打待核验标记 */
  repairWhys(members, movesets, tac);
  const playbook = buildPlaybook(tac, members, pr.links, movesets);
  assertSquadConsistency({ links: pr.links, playbook }, members, tac.key);
  return { links: pr.links, playbook, removedLinks: pr.removed, members };
}

/* enrich 模式：只给现有 rotation.json 的当前轮次按新管线重算 links 与
   playbook（成员/round/generatedAt/nextAt/分数全部不动）；links 如因
   关键技能超限被剔除会在日志里逐条明示；重复运行结果一致（幂等）。
   任一阵容断言失败或剔链后 links <2 → 抛错停手，文件不写。 */
function enrich(){
  const raw = fs.readFileSync(ROT_PATH, 'utf8');
  const j = JSON.parse(raw);
  if (!j || !Array.isArray(j.squads) || !j.squads.length) throw new Error('rotation.json 结构异常，无可 enrich 的轮次');
  const removedReport = [];
  j.squads.forEach(sq => {
    const tac = TACTICS.find(t => t.key === sq.tactic) || { key: sq.tactic, weather: null };
    const members = sq.members.map(mo => {
      const pet = A.DB.petById[mo.id];
      if (!pet) throw new Error('rotation.json 成员 id=' + mo.id + ' 在图鉴里找不到');
      return { pet, role: mo.role, why: mo.why };
    });
    /* 第 12 期：links 必须按修复后的 squadLinks 重新生成（旧 link 文案本身
       就是审计对象——引爆模板/奉献双链等都在文案里），不能沿用旧对象；
       成员名单不变 ⇒ 链的 (a|via|b) 身份由同一判定函数确定性重算。 */
    const fin = finalizeSquad(tac, members, null, 'enrich');
    sq.links = fin.links;
    sq.playbook = fin.playbook;
    /* 第 12 期：why 按配招口径修复后写回（成员名单/role/分数/时间不动），
       待核验标记同步；pros/cons 也按修复后的 makePros/makeCons 重算
       （背书口径与 caveat 都是审计对象，成员与分数不变 ⇒ 纯文案重算）；
       写回后再对成品（含 intro/pros）跑一遍全量闸门。 */
    sq.members.forEach((mo, i) => {
      mo.why = fin.members[i].why;
      if (fin.members[i].restrictedSlot) mo.restrictedSlot = true; else delete mo.restrictedSlot;
    });
    const met = metOf(members.map(m => m.pet));
    sq.pros = makePros(tac, members, met, fin.links);
    sq.cons = makeCons(tac, members, met);
    assertSquadConsistency(sq, members, tac.key);
    /* 第 16 期：带 energy 的阵容在 enrich 后按新配招重算能量段并过能量闸门，
       保证能量明细永远与最终配招一致（失败抛错、不写文件）。 */
    if (sq.energy){
      attachEnergy(sq, tac, members, fin.playbook);
      assertEnergyGate(sq, members);
    }
    if (fin.removedLinks.length)
      removedReport.push(sq.title + ' 剔除 ' + fin.removedLinks.length + ' 条：' +
        fin.removedLinks.map(L => L.a + '「' + L.via + '」→' + L.b + (L._blood ? '（血脉互斥）' : '')).join('、'));
  });
  fs.writeFileSync(ROT_PATH, JSON.stringify(j, null, 1) + '\n');
  log('enrich 完成：第 ' + j.round + ' 轮 ' + j.squads.length + ' 套已按一致性管线重算（' +
    j.squads.map(s => s.title + ' 起手=' + s.playbook.lead.name).join('；') + '），其余字段未动');
  if (removedReport.length) log('links 剔除明细：' + removedReport.join('；'));
  else log('links 无剔除');
}

/* ---------------- 16. 能量引擎（第 16 期） ----------------
 * 能量模型参数与来源（查证全文见 ENERGY-phase16.md）：
 * - 能量上限 10/只【实锤】：thegameswiki 战斗系统页「Every spirit enters
 *   battle with a total energy budget of 10 points」；GameRes 体验拆解
 *   「上限10能量」；用户给定框架同值。
 * - 默认初始能量 10（满能量入场）【外部出处】：thegameswiki 同句（以
 *   10 点预算入场）+ 玩家复刻引擎（DeepWiki roco-world-ai）「starts
 *   with full energy (equal to its cap)」；例外只有特性 desc 明文
 *   「初始能量为0」者（5 条特性 / 14 只精灵，逐只解析自 desc）。
 * - 聚能 +5【多源旁证，官方逐字待验证】：GameRes「使用『聚能』行动
 *   一次获得5能量」；交易猫攻略「休息回复5点」；thegameswiki 只写
 *   回复「a portion」。BWIKI 技能「过充电」desc 以「聚能至少1次」
 *   为条件，旁证聚能是游戏内真实行动。
 * - 换人耗当回合行动、不耗能量【外部出处】：thegameswiki「switching
 *   consumes the turn's action」；「入场扣能量」查无任何明文，建模为
 *   不存在。用户所说「上场能量」在本模型中对应「初始能量」——逐只
 *   由特性 desc 算（648 只 = 10、14 只 = 0），不是默认假设。
 * - 场下精灵各自持有能量【数据明文】：加大功率（替换入场者 +8）、
 *   富养化（场下每个 +3）、养分回流（场下所有 +1）与「初始能量为0」
 *   系的入场前充能，互相自洽。突破上限仅限 desc 明文特性（盗魂铃
 *   「可突破上限」、地脉馈赠「突破能量上限」）。无被动逐回合回能
 *   【建模假设】：回能只有聚能 / 技能 / 特性三路，与全部已查来源一致。
 * - 与 PVP「魔力」（4 点、被击倒 -1，thegameswiki Morale Points；
 *   数据 desc「魔力值」同指）严格区分，魔力不进能量账。 */
const ENERGY_CAP = 10, ENERGY_INIT = 10, ENERGY_GATHER = 5;

function abilityDescOf(pet){
  if (!pet.ability) return '';
  const ab = A.DB.abilityByName[pet.ability];
  return ab ? String(ab.desc || '') : '';
}
/* 初始能量 + 入场前充能规则：全部解析自特性 desc 原文，不查表外推 */
function energyInitOf(pet){
  const d = abilityDescOf(pet);
  const zeroInit = /初始能量为0/.test(d);
  const overCap = /突破能量上限|可突破上限/.test(d);
  let charge = null;
  if (/入场前/.test(d)){
    for (const seg of String(d).split(/[。；]/)){
      if (!/入场前/.test(seg)) continue;
      const m = seg.match(/回复(\d+)能量/);
      if (!m) continue;
      let kind = 'other', type = null;
      const tm = seg.match(/每(?:放|使用)1次(.{1,2})系技能/);
      if (tm){ kind = 'skillType'; type = tm[1]; }
      else if (/每成功应对1次/.test(seg)) kind = 'respond';
      else if (/敌方每聚能1次/.test(seg)) kind = 'enemyGather';
      charge = { kind, type, per: parseInt(m[1], 10), text: seg };
      break;
    }
  }
  return { init: zeroInit ? 0 : ENERGY_INIT, zeroInit, overCap, charge,
    rule: zeroInit ? ('特性「' + pet.ability + '」：' + A.descFirst(d)) : null };
}
/* 特性侧的能量收支（入场前充能除外）：可解析的回能分句 + 其余能量分句原样保留 */
function traitEnergyNotes(pet){
  const d = abilityDescOf(pet);
  const out = { recovery: [], notes: [] };
  if (!d) return out;
  String(d).split(/[。；]/).forEach(seg => {
    if (!/能量/.test(seg)) return;
    if (/入场前/.test(seg) && /回复\d+能量/.test(seg)) return;   /* 充能规则单列 */
    if (/初始能量为0/.test(seg) && !/回复\d+能量/.test(seg.replace(/初始能量为0/, ''))) return;
    const m = seg.match(/回复(\d+)能量/);
    if (m && /回合结束时|离场时|造成克制伤害后|每次行动后/.test(seg))
      out.recovery.push({ text: seg, per: parseInt(m[1], 10),
        when: /回合结束时/.test(seg) ? 'turnEnd' : (/离场时/.test(seg) ? 'onLeave' : 'other'),
        condZero: /能量为0/.test(seg) });
    else out.notes.push(seg);
  });
  return out;
}
/* 技能的能量角色（desc 解析）：自回 / 场下供能 / 接棒供能 / 奉献 */
function skillEnergyRoles(sk){
  const d = String((sk && sk.desc) || '');
  const out = {};
  let m = d.match(/自己回复(\d+)能量/); if (m) out.self = parseInt(m[1], 10);
  m = d.match(/为场下(?:每个|所有)精灵回复(\d+)能量/); if (m) out.bench = parseInt(m[1], 10);
  m = d.match(/替换入场的精灵回复(\d+)能量/); if (m) out.enter = parseInt(m[1], 10);
  if (/己方队伍获得1次奉献/.test(d)) out.offering = true;
  return out;
}
/* 单只精灵的能量画像：入场能量（逐只算）、配招能耗曲线、回能/供能来源 */
function petEnergyProfile(pet, moves){
  const ei = energyInitOf(pet);
  const tn = traitEnergyNotes(pet);
  const costs = (moves || []).map(mv => ({ name: mv.name, energy: mv.energy == null ? null : mv.energy }));
  const nums = costs.map(c => c.energy || 0);
  const totalCost = nums.reduce((a, b) => a + b, 0);
  const maxCost = nums.length ? Math.max.apply(null, nums) : 0;
  const bigMove = costs.find(c => (c.energy || 0) === maxCost && maxCost > 0) || null;
  const selfRecovery = [], feed = [];
  (moves || []).forEach(mv => {
    const sk = A.skillOf(mv.name); if (!sk) return;
    const r = skillEnergyRoles(sk);
    if (r.self) selfRecovery.push({ name: mv.name, per: r.self });
    if (r.bench) feed.push({ name: mv.name, kind: '场下供能', per: r.bench });
    if (r.enter) feed.push({ name: mv.name, kind: '接棒供能', per: r.enter });
    if (r.offering) feed.push({ name: mv.name, kind: '奉献（单次能耗-2）', per: null });
  });
  return { id: pet.id, name: pet.name, ability: pet.ability || null,
    init: ei.init, zeroInit: ei.zeroInit, overCap: ei.overCap,
    initRule: ei.rule, charge: ei.charge,
    movesCost: costs, totalCost, maxCost,
    minCost: nums.length ? Math.min.apply(null, nums) : 0,
    bigMove: bigMove ? bigMove.name : null,
    traitRecovery: tn.recovery, traitNotes: tn.notes,
    selfRecovery, feed, path: null };
}
function recoveryPathOf(profile, allProfiles){
  if (profile.traitRecovery.length) return '特性回能';
  if (profile.selfRecovery.length) return '配招自回（' + profile.selfRecovery[0].name + '）';
  const f = allProfiles.find(q => q.id !== profile.id && q.feed.some(x => x.kind !== '奉献（单次能耗-2）'));
  if (f) return '队友供能（' + f.name + '）';
  return null;
}
function teamEnergyOf(members, movesets){
  const byId = new Map(movesets.map(ms => [ms.id, ms.moves]));
  const perPet = members.map(m => petEnergyProfile(m.pet, byId.get(m.pet.id) || []));
  perPet.forEach(pr => { pr.path = recoveryPathOf(pr, perPet); });
  const team = {
    initShortfall: perPet.reduce((s, p) => s + (ENERGY_CAP - p.init), 0),
    zeroInit: perPet.filter(p => p.zeroInit).map(p => p.name),
    feeders: perPet.filter(p => p.feed.length).map(p => ({ pet: p.name, skills: p.feed.map(f => f.name) })),
    sustainers: perPet.filter(p => p.traitRecovery.length).map(p => p.name),
    avgTotalCost: Math.round(perPet.reduce((s, p) => s + p.totalCost, 0) / Math.max(1, perPet.length) * 10) / 10,
    consumers: perPet.filter(p => p.maxCost >= 7).map(p => ({ pet: p.name, bigMove: p.bigMove, cost: p.maxCost, path: p.path })),
    closedLoop: perPet.filter(p => p.maxCost >= 7).every(p => !!p.path),
  };
  return { perPet, team };
}
/* 前 3 回合能量账：按手册剧本推演——T1 起手动作（与 buildPlaybook 同口径
   取起手资源）、T2 起手主攻、T3 收割手入场打最大招；每步先验可支付，
   付不起自动降级（次优主攻 → 最廉价招 → 聚能 +5）。回能只计三种明文
   来源：技能自回（desc)、回合结束特性回能（desc)、加大功率接棒 +8、
   预充位在场下被己方技能喂到的充能（只计本方 T1/T2 实际用出的技能
   属性，可从本账复算）。盗魂铃「在场回复 -4」等惩罚分句不入账，
   在其 traitNotes 里原样保留、页面可见。 */
function ledgerOf(members, movesets, perPet, tac){
  const byId = new Map(movesets.map(ms => [ms.id, ms.moves]));
  const prof = new Map(perPet.map(p => [p.id, p]));
  const mvList = pet => (byId.get(pet.id) || []);
  function bestMove(pet){
    let best = null, be = 0;
    mvList(pet).forEach(mv => {
      const sk = A.skillOf(mv.name); if (!sk) return;
      if (/(消耗|失去)全部(生命|体力)|同归于尽/.test(sk.desc || '')) return;
      const e = A.effPower(pet, sk);
      if (e > be){ be = e; best = mv; }
    });
    return best;
  }
  function cheapMove(pet){
    const atk = mvList(pet).filter(mv => { const sk = A.skillOf(mv.name); return sk && sk.power != null; });
    const list = atk.length ? atk : mvList(pet);
    return list.slice().sort((a, b) => (a.energy || 0) - (b.energy || 0))[0] || null;
  }
  function capOf(pet){ const pr = prof.get(pet.id); return pr && pr.overCap ? Infinity : ENERGY_CAP; }
  function turnEndGain(pet, energyAfter){
    const pr = prof.get(pet.id);
    let g = 0; const notes = [];
    (pr ? pr.traitRecovery : []).forEach(r => {
      if (r.when !== 'turnEnd') return;
      if (r.condZero && energyAfter !== 0) return;
      g += r.per; notes.push('特性「' + pet.ability + '」回合结束 +' + r.per);
    });
    return { g, notes };
  }
  function act(pet, energy, planned){
    let mv = planned || null;
    if (mv && (mv.energy || 0) > energy) mv = null;
    if (!mv){ const bm = bestMove(pet); if (bm && (bm.energy || 0) <= energy) mv = bm; }
    if (!mv){ const cm = cheapMove(pet); if (cm && (cm.energy || 0) <= energy) mv = cm; }
    if (!mv) return { action: '聚能', cost: 0, gain: ENERGY_GATHER,
      after: Math.min(capOf(pet), energy + ENERGY_GATHER),
      note: '能量不足以支付任何配招，按规则聚能 +' + ENERGY_GATHER + '（占本回合行动）' };
    const sk = A.skillOf(mv.name);
    const roles = sk ? skillEnergyRoles(sk) : {};
    let after = energy - (mv.energy || 0), gain = 0;
    const notes = [];
    if (roles.self){ gain += roles.self; after += roles.self; notes.push('「' + mv.name + '」自回 +' + roles.self); }
    const te = turnEndGain(pet, after);
    if (te.g){ gain += te.g; after += te.g; notes.push.apply(notes, te.notes); }
    return { action: mv.name, cost: mv.energy || 0, gain,
      after: Math.min(capOf(pet), after), note: notes.join('；') };
  }
  const leadC = pickLead(members, tac);
  const lead = leadC.pet;
  const lp = prof.get(lead.id);
  const rows = [];
  const cited = leadC.res.filter(r => r.ev.k === '特性' || mvList(lead).some(mv => mv.name === r.ev.n));
  let prim = null;
  for (const k of ['weather', 'feed', 'setup', 'prio']){ prim = cited.find(x => x.kind === k) || null; if (prim) break; }
  const planned1 = (prim && prim.ev.k === '技能') ? (mvList(lead).find(mv => mv.name === prim.ev.n) || null) : null;
  const r1 = act(lead, lp.init, planned1);
  rows.push(Object.assign({ turn: 1, actor: lead.name, before: lp.init }, r1));
  const r2 = act(lead, r1.after, bestMove(lead));
  rows.push(Object.assign({ turn: 2, actor: lead.name, before: r1.after }, r2));
  const finCands = members.filter(m => m.pet !== lead).map(m => {
    const bm = bestMove(m.pet);
    const eff = bm ? A.effPower(m.pet, A.skillOf(bm.name)) : 0;
    return { pet: m.pet, score: eff + m.pet.stats.spe * 0.5, burst: eff };
  }).sort((a, b) => b.score - a.score);
  let fin = finCands[0].pet;
  for (const c of finCands){ if (c.burst >= 90){ fin = c.pet; break; } }
  const fp = prof.get(fin.id);
  let start = fp.init;
  const startNotes = [];
  if (rows[0].action === '加大功率'){ start += 8; startNotes.push('接棒供能：「加大功率」给替换入场者 +8'); }
  if (fp.zeroInit && fp.charge){
    if (fp.charge.kind === 'skillType'){
      let gained = 0, hits = 0;
      [rows[0], rows[1]].forEach(r => {
        const sk = A.skillOf(r.action);
        if (sk && sk.type === fp.charge.type){ gained += fp.charge.per; hits++; }
      });
      if (gained){ start += gained; startNotes.push('场下预充：前两回合己方用出 ' + hits + ' 次' + fp.charge.type + '系技能，特性「' + fin.ability + '」累计 +' + gained); }
      else startNotes.push('场下预充：前两回合己方未用出' + fp.charge.type + '系技能，特性「' + fin.ability + '」未充到能量');
    } else {
      startNotes.push('特性「' + fin.ability + '」的充能条件（' + fp.charge.text + '）不由本方剧本控制，按 0 计');
    }
  }
  start = Math.min(capOf(fin), start);
  const finBig = mvList(fin).slice().sort((a, b) => (b.energy || 0) - (a.energy || 0))[0] || null;
  const r3 = act(fin, start, finBig);
  const note3 = [startNotes.join('；'), r3.note].filter(Boolean).join('；');
  rows.push(Object.assign({ turn: 3, actor: fin.name, before: start }, r3, { note: note3 }));
  return rows;
}
/* 能量维度打分（只用于第 16 期主题战术的构建分，不动 scoreTeam 四项口径）：
   配招便宜、带回能/供能者占优；初始能量为 0 者在通用语境下需预充、略扣，
   在能量经济队里由充能喂养关系另行加分。 */
const _dispCache = new Map(), _profCache = new Map(), _bestEffCache = new Map();
function dispMovesOf(pet){
  if (!_dispCache.has(pet.id)) _dispCache.set(pet.id, buildMoveset(pet, []));
  return _dispCache.get(pet.id);
}
function quickProfile(pet){
  if (!_profCache.has(pet.id)) _profCache.set(pet.id, petEnergyProfile(pet, dispMovesOf(pet)));
  return _profCache.get(pet.id);
}
function energyFitScore(pet){
  const pr = quickProfile(pet);
  let s = -pr.totalCost * 1.2;
  s += pr.selfRecovery.length * 18 + pr.traitRecovery.length * 22 + pr.feed.length * 20;
  if (pr.zeroInit) s -= 6;
  return s;
}
function bestEffMvOf(pet){
  if (_bestEffCache.has(pet.id)) return _bestEffCache.get(pet.id);
  let b = null, be = 0;
  dispMovesOf(pet).forEach(mv => {
    const sk = A.skillOf(mv.name); if (!sk || sk.power == null) return;
    const e = A.effPower(pet, sk);
    if (e > be){ be = e; b = { name: mv.name, energy: mv.energy, eff: e }; }
  });
  _bestEffCache.set(pet.id, b);
  return b;
}
/* ---------------- 16.5 主题战术构建器（第 16 期，用户点单） ----------------
 * 三个主题战术与既有战术同池注册（addTac），构建/优化/一致性管线完全
 * 复用：buildBest 的 best-of-N + finalizeSquad（关键技能锁定、血脉、
 * 语义闸门）+ 本期 assertEnergyGate。scoreTeam 四项口径不动，能量只
 * 进构建分与校验，不改全站评分。 */
function buildBurstout(rng){
  const st = A.newSquadState();
  /* 初始能量为 0 的精灵入场打不出第一波爆发（要先预充），爆发池排除 */
  const pool = A.DB.pets.filter(p => p.stats.spe >= 90 && !energyInitOf(p).zeroInit);
  for (let i = 0; i < 5; i++){
    const p = pickJ(st, pool, x => burstOf(x) * 0.75 + x.stats.spe * 1.15 + A.outScore(x) * 0.3 + A.synergyBonus(x, stPetsOf(st)), rng, 30);
    if (!p) break;
    const bm = bestEffMvOf(p);
    A.squadAdd(st, p, i === 0 ? '💥 爆发核心' : '💥 高速爆发',
      '速度 ' + p.stats.spe + '，最强一招「' + (bm ? bm.name : '—') + '」有效威力 ' + (bm ? Math.round(bm.eff) : 0) +
      '、能耗 ★' + (bm ? bm.energy : '—') + '——满能量（10）入场可直接全额支付，第一波就打满。总和 ' + p.stats.total + '。');
  }
  fillBlindJ(st, rng, 18, pool);
  return st.members;
}
function buildBalance(rng){
  const st = A.newSquadState();
  while (st.members.length < 6){
    const cur = stPetsOf(st);
    let best = null, bs = -Infinity, bRole = '⚔️ 输出位';
    A.DB.pets.forEach(p => {
      if (!A.squadAvail(st, p)) return;
      const pr = quickProfile(p);
      if (pr.zeroInit) return; // 均衡队能量曲线中庸：不收初始能量为 0 的预充位（第 16 期口径）
      const trial = cur.concat([p]);
      const sc = A.scoreTeam(trial, null);
      const wc = A.weakCounts(trial);
      const maxW = Math.max.apply(null, TYPES18.map(a => wc[a]));
      const s = sc.total + sc.parts[1].score * 0.4 - maxW * 13 + A.superCountOf(trial) * 2 +
        A.duraOf(p) * 0.07 +
        A.sustainSkillsOf(p).length * 3 + Math.min(petFlagsX(p).ctrlN, 3) * 2 +
        (pr.selfRecovery.length + pr.feed.length) * 5 - Math.max(0, pr.totalCost - 16) * 1.5 -
        (pr.zeroInit ? 25 : 0) +
        A.synergyBonus(p, cur) * 0.3 + (rng ? rng() * 16 : 0);
      if (s > bs){ bs = s; best = p; bRole = profileRole(p); }
    });
    if (!best) break;
    const trial = cur.concat([best]);
    const wc2 = A.weakCounts(trial);
    const maxW2 = Math.max.apply(null, TYPES18.map(a => wc2[a]));
    A.squadAdd(st, best, bRole,
      '均衡选人：补入后全队共同弱点最多 ' + maxW2 + ' 只重叠、打击面覆盖 ' + A.superCountOf(trial) +
      '/18；它的配招总能耗 ★' + quickProfile(best).totalCost + '（曲线中庸，不透支）。总和 ' + best.stats.total +
      '、耐久 ' + A.duraOf(best) + '、速度 ' + best.stats.spe + '。');
  }
  return st.members;
}
function buildEnergyecon(rng){
  const st = A.newSquadState();
  const zeroPool = A.DB.pets.filter(p => energyInitOf(p).zeroInit);
  const a1 = pickJ(st, zeroPool, p => p.stats.total + A.duraOf(p) * 0.25 + (energyInitOf(p).charge ? 20 : 0), rng, 20);
  if (a1) A.squadAdd(st, a1, '🔋 蓄能王牌',
    '预充王牌：特性「' + a1.ability + '」——' + A.descFirst(abilityDescOf(a1)) +
    '。它在场下靠队友行动把能量攒起来，换它入场不耗任何能量（换人不耗能）、入场即按预充量发力。总和 ' +
    a1.stats.total + '、耐久 ' + A.duraOf(a1) + '。');
  const a2pool = A.DB.pets.filter(p => { const ei = energyInitOf(p); return ei.zeroInit || ei.overCap; });
  const a2 = pickJ(st, a2pool, p => p.stats.total + A.duraOf(p) * 0.2, rng, 20);
  if (a2 && a2 !== a1){
    const ei2 = energyInitOf(a2);
    A.squadAdd(st, a2, ei2.zeroInit ? '🔋 蓄能王牌' : '🔋 破限位',
      (ei2.zeroInit ? '第二预充位：特性「' + a2.ability + '」——' : '破限位：特性「' + a2.ability + '」——') +
      A.descFirst(abilityDescOf(a2)) + '。总和 ' + a2.stats.total + '、耐久 ' + A.duraOf(a2) + '。');
  }
  const feedPool = A.DB.pets.filter(p => A.energyFeedOf(p).some(e => e.n === '富养化' || e.n === '养分回流'));
  const fd = pickJ(st, feedPool, p => p.stats.total + traitEnergyNotes(p).recovery.length * 60 + A.duraOf(p) * 0.15, rng, 20);
  if (fd){
    const fsk = A.energyFeedOf(fd).filter(e => e.n === '富养化' || e.n === '养分回流')[0];
    const tn = traitEnergyNotes(fd);
    A.squadAdd(st, fd, '🔋 供能位',
      '供能位：技能「' + fsk.n + '」——' + A.descFirst((A.skillOf(fsk.n) || {}).desc || '') +
      (tn.recovery.length ? '；特性「' + fd.ability + '」还能' + tn.recovery[0].text : '') +
      '。它在场上给场下全队充电，是预充王牌的发动机。总和 ' + fd.stats.total + '。');
  }
  const susPool = A.DB.pets.filter(p => traitEnergyNotes(p).recovery.some(r => r.when === 'turnEnd'));
  const su = pickJ(st, susPool, p => p.stats.total + A.duraOf(p) * 0.2, rng, 20);
  if (su) A.squadAdd(st, su, '🔋 续航位',
    '续航位：特性「' + su.ability + '」——' + traitEnergyNotes(su).recovery[0].text +
    '。它站场越久能量越满，是全队最不用操心能量的轮换点。总和 ' + su.stats.total + '、耐久 ' + A.duraOf(su) + '。');
  const chargeTypes = new Set();
  st.members.forEach(m => { const c = energyInitOf(m.pet).charge; if (c && c.type) chargeTypes.add(c.type); });
  while (st.members.length < 5){
    const p = pickJ(st, A.DB.pets, x => {
      const pr = quickProfile(x);
      const mvTypes = new Set(dispMovesOf(x).map(mv => (A.skillOf(mv.name) || {}).type));
      let feedN = 0; chargeTypes.forEach(t => { if (mvTypes.has(t)) feedN++; });
      return A.outScore(x) * 0.7 + feedN * 26 + (pr.totalCost <= 13 ? 18 : 0) +
        pr.selfRecovery.length * 12 + A.synergyBonus(x, stPetsOf(st));
    }, rng, 24);
    if (!p) break;
    const pr = quickProfile(p);
    const fed = [...chargeTypes].filter(t => dispMovesOf(p).some(mv => (A.skillOf(mv.name) || {}).type === t));
    A.squadAdd(st, p, '⚔️ 充能输出',
      '充能输出：配招总能耗 ★' + pr.totalCost + '（便宜耐打）' +
      (fed.length ? '，且带 ' + fed.join('、') + '系技能——它每次出手都在给场下的预充王牌充能' : '') +
      '。总和 ' + p.stats.total + '、速度 ' + p.stats.spe + '。');
  }
  fillBlindJ(st, rng, 18, null);
  return st.members;
}
addTac({
  key: 'burstout', title: '高爆发输出队', emoji: '💥', tag: '战术 · 前置爆发',
  build: buildBurstout,
  pool: () => topByTotal(A.DB.pets.filter(p => p.stats.spe >= 90), 90),
  validatePets: pets => {
    const avgSpe = pets.reduce((s, p) => s + p.stats.spe, 0) / pets.length;
    return avgSpe >= 100 && pets.filter(p => burstOf(p) >= 130).length >= 3 &&
      pets.every(p => { const bm = bestEffMvOf(p); return bm && bm.energy <= ENERGY_CAP; });
  },
  swappable: () => true,
  caveat: '爆发是前置的：大招连发两三轮后能量见底，必须拿聚能回合换能量——前两波没压出击杀，中期会被迫打低耗招过渡，聚能时机要挑对面换人或被压制的回合。',
});
addTac({
  key: 'balance', title: '均衡攻防队', emoji: '⚖️', tag: '战术 · 均衡攻防',
  build: buildBalance,
  pool: () => topGlobal(150),
  banPet: p => quickProfile(p).zeroInit,
  validatePets: pets => {
    const wc = A.weakCounts(pets);
    const maxW = Math.max.apply(null, TYPES18.map(a => wc[a]));
    const avgDura = pets.reduce((s, p) => s + A.duraOf(p), 0) / pets.length;
    const avgCost = pets.reduce((s, p) => s + quickProfile(p).totalCost, 0) / pets.length;
    return maxW <= 3 && A.superCountOf(pets) >= 11 &&
      pets.filter(p => A.sustainSkillsOf(p).length >= 1).length >= 2 &&
      pets.some(p => petFlagsX(p).ctrlN >= 2) && avgDura >= 370 && avgCost <= 17;
  },
  swappable: () => true,
  caveat: '均衡的代价是没有极端项：撞上纯爆发队要靠耐久与轮换扛过第一波，撞上纯消耗队要靠控制位先手压住对面的状态手，别被拖进对方的回合数里。',
});
addTac({
  key: 'energyecon', title: '能量经济队', emoji: '🔋', tag: '战术 · 能量经济',
  build: buildEnergyecon,
  pool: () => {
    const seen = new Set(); const out = [];
    A.DB.pets.filter(p => { const ei = energyInitOf(p); return ei.zeroInit || ei.overCap; })
      .concat(A.DB.pets.filter(p => A.energyFeedOf(p).length))
      .concat(A.DB.pets.filter(p => traitEnergyNotes(p).recovery.length))
      .concat(topGlobal(60))
      .forEach(p => { if (!seen.has(p.id)){ seen.add(p.id); out.push(p); } });
    return out;
  },
  validatePets: pets => {
    const profs = pets.map(p => quickProfile(p));
    if (!profs.some(p => p.zeroInit)) return false;
    const src = profs.filter(p => p.traitRecovery.length || p.selfRecovery.length || p.feed.length).length;
    if (src < 2) return false;
    const avgCost = profs.reduce((s, p) => s + p.totalCost, 0) / profs.length;
    return avgCost <= 16;
  },
  swappable: m => !/蓄能王牌|供能位|续航位|破限位/.test(m.role),
  caveat: '能量账算在入场前：预充王牌靠队友在场下喂对应属性的技能充能——队友属性对不上它的充能条件时，它就是一张 0 能量白板，绝不能冷启动首发；供能位倒下后全队回能只剩聚能，节奏会立刻变紧。',
});
const INTRO16 = {
  burstout: (ms, met) => '前置爆发：全员满能量（10 点）入场，第一波就把最贵的大招全额支付——平均速度 ' + met.avgSpe + ' 抢先手，前两回合的总火力就是胜负手。能量见底后的过渡打法与逐只账目见详情「能量明细」。',
  balance: (ms, met) => '均衡攻防：打击面 ' + met.superCount + '/18、平均耐久 ' + met.avgDura + '、共同弱点最多 ' + met.weakMax + ' 只重叠，续航与控制都留了人；能量曲线中庸，不靠一波爆发、也不怕被拖进消耗战，靠轮换与覆盖面磨优势。',
  energyecon: (ms, met) => '能量经济：预充王牌初始能量为 0，靠队友在场下用对应属性技能把能量喂满再入场；供能位给场下全员回能、续航位带特性回能，全队配招总能耗压到最低——把别人用来聚能的回合，全部换成输出。轮换顺序与逐回合能量账见详情。',
};
INTRO.burstout = INTRO16.burstout;
INTRO.balance = INTRO16.balance;
INTRO.energyecon = INTRO16.energyecon;

/* ---------------- 16.6 能量明细装配：轮换计划 + 对位策略 + 闸门 ---------------- */
function buildRotationText(tac, members, energy, leadName){
  const byName = new Map(energy.perPet.map(p => [p.name, p]));
  const parts = [];
  const leadPr = byName.get(leadName);
  parts.push('首发 ' + leadName + '（入场能量 ' + (leadPr ? leadPr.init : ENERGY_INIT) +
    '）：先按手册开局段把第一波资源打出去，它下场后能量保持，下次入场接着用。');
  energy.perPet.filter(p => p.zeroInit).forEach(p => {
    const ct = p.charge ? String(p.charge.text).replace(/^初始能量为0，/, '') : '';
    parts.push(p.name + ' 是预充轮换点：特性「' + p.ability + '」让它初始能量为 0，' +
      (p.charge ? '靠「' + ct + '」（每次 +' + p.charge.per + '）在场下攒能量' : '靠场下事件攒能量') +
      '——队友先在场上喂满它，再换它入场，换人本身不耗能量、它入场即按预充量发力；没喂满之前不要让它冷启动。');
  });
  const benchFeeder = energy.perPet.find(p => p.feed.some(f => f.kind === '场下供能' || f.kind === '接棒供能'));
  if (benchFeeder){
    const fs = benchFeeder.feed.filter(f => f.kind === '场下供能' || f.kind === '接棒供能').map(f => f.name);
    parts.push(benchFeeder.name + ' 的「' + fs.join('」「') + '」负责给场下精灵回能，安排在预充王牌入场前一回合用出，衔接最紧。');
  }
  const offerer = energy.perPet.find(p => p.feed.some(f => String(f.kind).indexOf('奉献') === 0));
  if (offerer){
    parts.push(offerer.name + ' 的「' + offerer.feed.filter(f => String(f.kind).indexOf('奉献') === 0).map(f => f.name).join('」「') +
      '」产出奉献（单次、全队共享一次能耗 -2），留给关键大招那一回合用，不要提前浪费。');
  }
  energy.team.sustainers.forEach(nm => {
    parts.push(nm + ' 带特性回能（触发方式见其特性原文），能量续航不用操心，适合多轮换、当长线轴心。');
  });
  const cheap = energy.perPet.slice().sort((a, b) => a.totalCost - b.totalCost)[0];
  if (cheap) parts.push('全队能量见底时先换 ' + cheap.name + '：它整套配招总能耗只有 ★' + cheap.totalCost + '，低耗招过渡 + 聚能一回合就能把节奏接回来。');
  return parts.join('');
}
function buildMatchups(tac, members, movesets){
  const byId = new Map(movesets.map(ms => [ms.id, new Set(ms.moves.map(x => x.name))]));
  const duraBest = members.slice().sort((a, b) => A.duraOf(b.pet) - A.duraOf(a.pet))[0];
  const fastBest = members.slice().sort((a, b) => b.pet.stats.spe - a.pet.stats.spe)[0];
  const ctrlBest = members.slice().sort((a, b) => petFlagsX(b.pet).ctrlN - petFlagsX(a.pet).ctrlN)[0];
  let setter = null;
  members.forEach(m => {
    (byId.get(m.pet.id) || new Set()).forEach(n => {
      const sk = A.skillOf(n);
      if (sk && /将天气改为/.test(sk.desc || '')) setter = { pet: m.pet, skill: n, weather: (String(sk.desc).match(/将天气改为([^，。；]+)/) || [])[1] };
    });
  });
  const respN = members.filter(m => petFlagsX(m.pet).responds.some(e => e.k === '特性' || (byId.get(m.pet.id) || new Set()).has(e.n))).length;
  return [
    { vs: '高速爆发队', text: '先扛第一波：' + duraBest.pet.name + '（耐久 ' + A.duraOf(duraBest.pet) + '）顶在前面吃爆发' +
      (respN ? '，队里 ' + respN + ' 只带应对触发条目，对面打过来反而触发本方效果' : '') +
      '；扛过两回合对面能量见底、被迫聚能时，用 ' + fastBest.pet.name + '（速度 ' + fastBest.pet.stats.spe + '）先手收割。' },
    { vs: '耐久消耗队', text: '不能陪它磨：' + (petFlagsX(ctrlBest.pet).ctrlN > 0
      ? ctrlBest.pet.name + ' 的控制/异常条目先手压住对面状态手，' : '本队控制条目不算多，') +
      '再用全队有效威力最高的大招点杀它的续航位——它的回复跟不上点杀速度时，消耗体系就断链。' },
    { vs: '天气体系队', text: setter
      ? '有天气手就不怕：' + setter.pet.name + ' 的「' + setter.skill + '」把天气改成' + setter.weather + '，直接覆盖对面的天气窗口，抢回场地主动权。'
      : '本队没有天气手：靠 ' + fastBest.pet.name + ' 的速度 ' + fastBest.pet.stats.spe + ' 先手点掉对面的天气手，别让它续上第二轮天气；天气窗口内避免用被该天气克制的属性硬换。' },
  ];
}
function buildEnergySection(tac, members, movesets, leadId){
  const te = teamEnergyOf(members, movesets);
  const lead = members.find(m => m.pet.id === leadId);
  const ledger = ledgerOf(members, movesets, te.perPet, tac);
  return {
    modelNote: '能量模型（第 16 期）：上限 10/只；默认满能量（10）入场，特性明文「初始能量为0」者入场为 0、靠入场前事件预充；换人不耗能量；回能只有聚能（+5，占一回合行动）、技能、特性三路。参数来源与待验证项见仓库 ENERGY-phase16.md。',
    perPet: te.perPet,
    team: te.team,
    ledger,
    rotation: buildRotationText(tac, members, te, lead ? lead.pet.name : ''),
    matchups: buildMatchups(tac, members, movesets),
  };
}
/* 能量闸门：与 assertSquadConsistency 平行，默认主题生成与 --check-energy
   都执行。核心是「重算比对」——perPet/团队缺口/前 3 回合账全部由配招与
   特性 desc 重新算一遍，与存盘值逐项比对，伪造任何一处都会被抓出；
   另加三条硬规则：单招能耗不得超上限 10、账面每步必须可支付、
   能量经济队的结构规则（预充位 ≥1、回能/供能源 ≥2、大招 ≥★8 者必须
   有回能路径——高耗无回复直接拦截）。 */
function assertEnergyGate(sq, members){
  if (!sq.energy) throw new Error('能量闸门：' + (sq.title || sq.tactic) + ' 缺 energy 明细（第 16 期）');
  const errs = [];
  const movesets = sq.playbook.movesets;
  const re = teamEnergyOf(members, movesets);
  const st = sq.energy;
  const sig = pp => JSON.stringify(pp.map(p => [p.id, p.init, p.totalCost, p.maxCost]));
  if (sig(st.perPet) !== sig(re.perPet)) errs.push('perPet 与按配招/特性重算不一致（入场能量或能耗数值被改动）');
  if (st.team.initShortfall !== re.team.initShortfall) errs.push('team.initShortfall 与重算不一致');
  movesets.forEach(ms => ms.moves.forEach(mv => {
    if ((mv.energy || 0) > ENERGY_CAP)
      errs.push(ms.name + ' 配招「' + mv.name + '」展示能耗 ★' + mv.energy + ' 超过能量上限 ' + ENERGY_CAP);
  }));
  const tac = TACTICS.find(t => t.key === sq.tactic) || { key: sq.tactic };
  const reLedger = ledgerOf(members, movesets, re.perPet, tac);
  if (JSON.stringify(reLedger) !== JSON.stringify(st.ledger)) errs.push('前 3 回合能量账与重算不一致');
  (st.ledger || []).forEach(r => {
    if (r.before < r.cost) errs.push('第 ' + r.turn + ' 回合 ' + r.actor + ' 能量 ' + r.before + ' 不足以支付「' + r.action + '」★' + r.cost + '（开局序列不可支付）');
  });
  if (sq.tactic === 'energyecon'){
    if (!re.perPet.some(p => p.zeroInit)) errs.push('能量经济队没有初始能量为 0 的预充位');
    const src = re.perPet.filter(p => p.traitRecovery.length || p.selfRecovery.length || p.feed.length).length;
    if (src < 2) errs.push('能量经济队回能/供能源只有 ' + src + ' 个（须 ≥2）');
    re.perPet.forEach(p => {
      if (p.maxCost >= 8 && !p.path) errs.push(p.name + ' 的大招 ★' + p.maxCost + ' 无任何回能路径（高耗无回复）');
    });
  }
  // 预充位（按技能属性充能）必须有队友能喂：其他成员最终配招里要有该属性技能，
  // 否则轮换文案「队友先喂满它」就是空话（第 16 期审出：均衡队火焰猿无人喂火）
  re.perPet.forEach(p => {
    if (p.zeroInit && p.charge && p.charge.kind === 'skillType'){
      const fed = movesets.some(ms => ms.id !== p.id && ms.moves.some(mv => {
        const sk = A.skillOf(mv.name); return sk && sk.type === p.charge.type;
      }));
      if (!fed) errs.push(p.name + ' 是预充位（靠' + p.charge.type + '系技能充能），但无队友的最终配招含' + p.charge.type + '系技能可喂能');
    }
  });
  if (errs.length) throw new Error('能量闸门失败（' + sq.tactic + '）：' + errs.join('；'));
}
/* --themed：用户点单的主题重构轮——在现轮次上 +1，3 套主题阵容整轮
   替换。与上一轮的重合 ≤2 约束本轮豁免（理由：本轮是用户指定的主题
   重构、不是常规轮换；轮内 3 套之间仍守 ≤2）。写盘前每套过一致性
   断言 + 能量闸门，任一失败抛错不写文件。 */
/* 把能量明细挂到成品阵容上并补能量口径的 pros/cons（主题生成与 enrich 共用，
   保证 enrich 重算后能量段与新配招一致、且过能量闸门）。 */
function attachEnergy(sq, tac, members, playbook){
  sq.energy = buildEnergySection(tac, members, playbook.movesets, playbook.lead.id);
  if (tac.key === 'burstout')
    sq.pros.push('能量前置：6 只入场能量合计 60 点（全员满能量），第一波大招全部可直接支付（见能量明细）');
  if (tac.key === 'energyecon'){
    const zi = sq.energy.team.zeroInit;
    sq.pros.push('预充轮换：' + zi.join('、') + ' 初始能量为 0、靠队友在场下预充，入场不耗能量且按预充量发力（见能量明细）');
    if (!sq.energy.team.closedLoop) sq.cons.push('能量闭环未完全成立：个别大招缺回能路径（逐只见能量明细的回能路径），要靠聚能回合过渡');
  }
  if (tac.key === 'balance')
    sq.pros.push('能量中庸：全队平均配招总能耗 ★' + sq.energy.team.avgTotalCost + '，没有必须靠聚能才能转起来的高耗点（见能量明细）');
}
function themedMain(){
  const prev = readPrev();
  if (!prev) throw new Error('themed 需要已有 rotation.json 作为上一轮');
  const round = (prev.round || 0) + 1;
  const seedBase = hashSeed(prev.generatedAt + '|' + round + '|themed16');
  const keys = ['burstout', 'balance', 'energyecon'];
  const chosen = [];
  for (const key of keys){
    const tac = TACTICS.find(t => t.key === key);
    const sets = chosen.map(c => new Set(c.ids));
    const cand = buildBest(tac, seedBase + key.length * 104729, sets, 2);
    if (!cand) throw new Error('主题阵容 ' + key + ' 构建未达标（配合链/校验不过），拒绝写文件');
    if (cand.score < FLOOR) throw new Error('主题阵容 ' + key + ' 综合分 ' + cand.score + ' < 门槛 ' + FLOOR + '，拒绝写文件');
    chosen.push({ tac, cand, met: metOf(cand.members.map(m => m.pet)), ids: cand.members.map(m => m.pet.id) });
    log('  主题入选 ' + key + '（' + tac.title + '）综合 ' + cand.score);
  }
  const now = new Date();
  const next = new Date(now.getTime() + 48 * 3600 * 1000);
  const squads = chosen.map((c, i) => {
    const introFn = INTRO[c.tac.key];
    const sq = {
      id: c.tac.key + '-r' + round + '-' + (i + 1),
      tactic: c.tac.key,
      title: c.tac.title,
      emoji: c.tac.emoji,
      tag: c.tac.tag,
      intro: introFn(c.cand.members, c.met, null),
      score: c.cand.score,
      scores: { total: c.met.score.total, parts: c.met.score.parts.map(pt => ({ key: pt.key, label: pt.label, score: pt.score })) },
      members: c.cand.members.map(m => {
        const o = { id: m.pet.id, name: m.pet.name, role: m.role, why: m.why };
        if (m.restrictedSlot) o.restrictedSlot = true;
        return o;
      }),
      links: c.cand.links,
      playbook: c.cand.playbook,
      pros: makePros(c.tac, c.cand.members, c.met, c.cand.links),
      cons: makeCons(c.tac, c.cand.members, c.met),
    };
    attachEnergy(sq, c.tac, c.cand.members, c.cand.playbook);
    return sq;
  });
  chosen.forEach((c, i) => {
    assertSquadConsistency(squads[i], c.cand.members, c.tac.key);
    assertEnergyGate(squads[i], c.cand.members);
  });
  const out = { round, generatedAt: now.toISOString(), nextAt: next.toISOString(),
    squads, prevSquads: prev.squads.map(s => s.members.map(m => m.id)) };
  fs.writeFileSync(ROT_PATH, JSON.stringify(out, null, 1) + '\n');
  log('已写入第 ' + round + ' 轮（主题重构轮）：' + squads.map(s => s.title + ' ' + s.score).join(' / '));
  squads.forEach(s => {
    const ov = prev.squads.map(ps => ps.members.filter(m => s.members.some(x => x.id === m.id)).length);
    log('  ' + s.title + ' 与上一轮 3 套的重合数（本轮豁免 ≤2 约束）：' + ov.join(' / '));
  });
}
/* --check-energy：对现盘 rotation.json 里带 energy 的阵容重跑能量闸门 */
function checkEnergy(){
  const j = JSON.parse(fs.readFileSync(ROT_PATH, 'utf8'));
  let n = 0;
  j.squads.forEach(sq => {
    if (!sq.energy) return;
    const members = sq.members.map(mo => ({ pet: A.DB.petById[mo.id], role: mo.role, why: mo.why }));
    assertEnergyGate(sq, members);
    n++;
    log('  能量闸门通过：' + sq.title);
  });
  log('check-energy 完成：' + n + ' 套带能量明细的阵容全部通过');
}
/* 破坏性自检（ENERGY_GATE_TEST=1）：① 真实能量经济队应过闸门；
   ② 伪造 perPet 入场能量必须被重算比对抓出；③ 临时拼一只「高耗无
   回复」队（能量账按同函数如实算好、只违反结构规则）必须被能量
   经济队规则拦截。三项全过才 exit 0。 */
function energyGateSelfTest(){
  const j = JSON.parse(fs.readFileSync(ROT_PATH, 'utf8'));
  const econ = j.squads.find(s => s.tactic === 'energyecon');
  if (!econ) throw new Error('自检需要先有 --themed 生成的能量经济队');
  const membersOf = sq => sq.members.map(mo => ({ pet: A.DB.petById[mo.id], role: mo.role, why: mo.why }));
  assertEnergyGate(econ, membersOf(econ));
  log('自检 1/3 通过：真实能量经济队过能量闸门');
  const forged = JSON.parse(JSON.stringify(econ));
  forged.energy.perPet[0].init = 4;
  let caught2 = false;
  try { assertEnergyGate(forged, membersOf(forged)); } catch (e) { caught2 = /重算不一致/.test(e.message); }
  if (!caught2) throw new Error('自检 2/3 失败：伪造入场能量未被拦截');
  log('自检 2/3 通过：伪造 perPet.init 被重算比对拦截');
  const pick = name => A.DB.pets.find(p => p.name === name);
  const fakePets = [pick('布克棱岩'), pick('奇丽果'), pick('克莱因龙')];
  A.DB.pets.forEach(p => {
    if (fakePets.length >= 6) return;
    if (fakePets.some(x => x.id === p.id)) return;
    const big = A.displayBigMove(p, 8);
    if (!big) return;
    if (traitEnergyNotes(p).recovery.length || energyInitOf(p).zeroInit) return;
    if (A.energyFeedOf(p).length) return;
    fakePets.push(p);
  });
  if (fakePets.length < 6) throw new Error('自检 3/3 失败：凑不齐高耗样本精灵');
  const fakeMembers = fakePets.map(p => ({ pet: p, role: '自检样本', why: '' }));
  const fakeMovesets = fakePets.map(p => {
    const atk = A.petSkills(p).filter(sk => sk.power != null && (sk.energy || 0) <= ENERGY_CAP && !/(消耗|失去)全部(生命|体力)/.test(sk.desc || ''))
      .sort((a, b) => (b.energy || 0) - (a.energy || 0)).slice(0, 4);
    return { id: p.id, name: p.name, moves: atk.map(sk => ({ name: sk.name, type: sk.type, category: sk.category, power: sk.power, energy: sk.energy })) };
  });
  const te = teamEnergyOf(fakeMembers, fakeMovesets);
  const fakeSq = { tactic: 'energyecon', title: '自检伪造队',
    playbook: { lead: { id: fakePets[0].id }, movesets: fakeMovesets },
    energy: { perPet: te.perPet, team: te.team, ledger: ledgerOf(fakeMembers, fakeMovesets, te.perPet, { key: 'energyecon' }) } };
  let caught3 = false, msg3 = '';
  try { assertEnergyGate(fakeSq, fakeMembers); } catch (e) { msg3 = e.message; caught3 = /无任何回能路径|回能\/供能源只有/.test(e.message); }
  if (!caught3) throw new Error('自检 3/3 失败：高耗无回复队未被结构规则拦截（' + msg3 + '）');
  log('自检 3/3 通过：高耗无回复队被能量经济队结构规则拦截（' + msg3.slice(0, 120) + '）');
  log('ENERGY_GATE_TEST 全部通过');
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
      intro: introFn(c.cand.members, c.met, (c.cand.playbook.movesets || []).map(ms => new Set(ms.moves.map(x => x.name)))),
      score: c.cand.score,
      scores: {
        total: c.met.score.total,
        parts: c.met.score.parts.map(pt => ({ key: pt.key, label: pt.label, score: pt.score })),
      },
      members: c.cand.members.map(m => {
        const o = { id: m.pet.id, name: m.pet.name, role: m.role, why: m.why };
        if (m.restrictedSlot) o.restrictedSlot = true;
        return o;
      }),
      links: c.cand.links,
      playbook: c.cand.playbook,
      pros: makePros(c.tac, c.cand.members, c.met, c.cand.links),
      cons: makeCons(c.tac, c.cand.members, c.met),
    };
    if (c.relaxed) sq.relaxed = true;
    return sq;
  });
  /* 写盘前对最终成品再跑一遍一致性硬断言（与 finalize 内部同口径，双保险） */
  chosen.forEach((c, i) => assertSquadConsistency(squads[i], c.cand.members, c.tac.key));
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
} else if (process.env.ENERGY_GATE_TEST) {
  energyGateSelfTest();
} else if (process.argv.includes('--check-energy')) {
  checkEnergy();
} else if (process.argv.includes('--themed')) {
  themedMain();
} else if (process.argv.includes('--enrich')) {
  enrich();
} else {
  main();
}
