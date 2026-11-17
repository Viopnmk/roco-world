#!/usr/bin/env python3
"""roco-world 数据管道 · 第 2 步：解析 + 合并 + 生成站点数据

输入：scraper/raw/ 下由 fetch_nrc.py 拉取的 BWIKI nrc 数据模块。
处理（合并规则与 BWIKI 自身的赛季适配器一致，见 模块:精灵图鉴/S5）：
  1. 基础层 Lua 表直接解析；
  2. S5 赛季分片按 dragon-tuples-1 编码解码；
  3. 赛季数据按 key 覆盖/追加到基础层：
     精灵→Catalog、技能+特性→Skills、辅助包按表名分别并入
     Learnsets / Evolutions / Handbooks / Index / Overview 等表；
  4. SeasonLearnsets 给旧精灵追加 S5 技能石；SeasonFeatures 给新精灵定特性。
输出（roco-world 自己的数据格式）：
  web/data/pets.json、web/data/skills.json、web/data/evolutions.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lua_parse import as_list, parse_lua  # noqa: E402

BASE = Path(__file__).resolve().parent.parent
RAW = BASE / "scraper" / "raw"
OUT = BASE / "web" / "data"


# ---------- 基础工具 ----------

def _norm(name: str) -> str:
    # fetch 落盘时模块名里的冒号保留为 : / ：，比较时与 _ 统一
    return name.replace("：", "_").replace(":", "_")


def load_module(fname: str):
    target = _norm(fname)
    for path in RAW.iterdir():
        if _norm(path.name) == target:
            return parse_lua(path.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"raw 缓存里找不到 {fname}，先跑 fetch_nrc.py")


def decode_shard(packed):
    """按 模块:精灵图鉴/S5 中 unpackShard 的规范解码 dragon-tuples-1 分片。"""
    codec, fields, root = packed[1], as_list(packed[2]), packed[3]
    if codec != "dragon-tuples-1":
        raise ValueError(f"不支持的分片编码: {codec}")

    def dec(value):
        if not isinstance(value, dict):
            return value
        tag = value[1]
        if tag == 1:  # 对象：{字段索引, 值} 列表
            return {fields[e[1] - 1]: dec(e[2]) for e in as_list(value[2])}
        if tag == 2:  # 数组
            return [dec(child) for child in as_list(value[2])]
        raise ValueError(f"无效的分片节点 tag={tag}")

    return dec(root)


def seq(value):
    """把 Lua 表的「序列部分」统一成 list：兼容解析出的 dict（整数键）与分片解码出的 list。"""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        out = as_list(value)
        return out if isinstance(out, list) else []
    return []


def type_name(raw: str) -> str:
    """属性名规范化：去「系」后缀；「幽」写作「幽灵」。"""
    t = (raw or "").removesuffix("系")
    return "幽灵" if t == "幽" else t


def skill_category(skill: dict) -> str:
    cat = skill.get("category")
    if cat == "特性":
        return "特性"
    if cat == "攻击":
        return "物理" if skill.get("damage_class") == "物攻" else "魔法"
    return "变化"  # 状态 / 防御


# ---------- 加载与合并 ----------

def load_all():
    catalog = load_module("模块_Pets_data_Catalog.txt")
    skills = load_module("模块_Pets_data_Skills.txt")
    learnsets = load_module("模块_Pets_data_Learnsets.txt")
    evolutions = load_module("模块_Pets_data_Evolutions.txt")
    handbooks = load_module("模块_Pets_data_Handbooks.txt")
    index = load_module("模块_Pets_data_Index.txt")
    overview = load_module("模块_Pets_data_Overview.txt")
    conditions = load_module("模块_Pets_EvolutionConditions.txt")

    roster = decode_shard(load_module("模块_精灵图鉴_S5_数据_精灵.txt"))
    arts = decode_shard(load_module("模块_精灵图鉴_S5_数据_技能.txt"))
    gifts = decode_shard(load_module("模块_精灵图鉴_S5_数据_特性.txt"))
    aux = decode_shard(load_module("模块_精灵图鉴_S5_数据_辅助.txt"))

    # 赛季覆盖（与 BWIKI 适配器相同的 per-key 覆盖语义）
    catalog.update(roster)
    skills.update(arts)
    skills.update(gifts)
    tables = {
        "Learnsets": learnsets,
        "Evolutions": evolutions,
        "Handbooks": handbooks,
        "Index": index,
        "Overview": overview,
    }
    for name, table in tables.items():
        patch = aux.get(name)
        if isinstance(patch, dict):
            if name == "Index":  # Index 是二级结构（avatars/by_name/...），逐子表合并
                for sub, values in patch.items():
                    if isinstance(values, dict) and isinstance(table.get(sub), dict):
                        table[sub].update(values)
                    else:
                        table[sub] = values
            else:
                table.update(patch)

    return {
        "catalog": catalog,
        "skills": skills,
        "learnsets": learnsets,
        "evolutions": evolutions,
        "handbooks": handbooks,
        "index": index,
        "overview": overview,
        "conditions": conditions,
        "season_learnsets": aux.get("SeasonLearnsets", {}),
        "season_features": aux.get("SeasonFeatures", {}),
        "aliases": aux.get("LegacyEvolutionAliases", {}),
    }


# ---------- 生成 ----------

def build():
    data = load_all()
    catalog, skills, learnsets = data["catalog"], data["skills"], data["learnsets"]
    handbooks, overview = data["handbooks"], data["overview"]
    season_learnsets, season_features = data["season_learnsets"], data["season_features"]

    warnings = []

    def skill_name(key):
        s = skills.get(key)
        if s is None:
            warnings.append(f"技能不存在: {key}")
            return key
        return s["name"]

    # 精灵按图鉴编号排序，我方 id 顺序生成
    def sort_key(item):
        key, pet = item
        try:
            num = int(pet.get("number", "9999"))
        except (TypeError, ValueError):
            num = 9999
        return (num, key)

    pets = []
    pet_id_by_key = {}
    referenced_skills = set()

    for key, pet in sorted(catalog.items(), key=sort_key):
        pid = len(pets) + 1
        pet_id_by_key[key] = pid

        # 特性：目录自带 feature_skill_id 优先，否则用赛季特性表
        ability_key = pet.get("feature_skill_id") or season_features.get(key)
        ability = None
        if ability_key:
            referenced_skills.add(ability_key)
            ability = skill_name(ability_key)

        # 学习面
        ls = learnsets.get(pet.get("learnset_id"), {})
        if not ls:
            warnings.append(f"学习面缺失: {key} {pet.get('title')}")
        level_out, stone_out, blood_out = [], [], []
        for entry in seq(ls.get("native_skills")):
            referenced_skills.add(entry["skill"])
            level_out.append({"lv": entry.get("level"), "skill": skill_name(entry["skill"])})
        extra = season_learnsets.get(key, {}).get("skill_stones", [])
        for sk in seq(ls.get("skill_stones")) + list(extra):
            referenced_skills.add(sk)
            stone_out.append(skill_name(sk))
        for entry in seq(ls.get("blood_skills")):
            referenced_skills.add(entry["skill"])
            blood_out.append({"type": type_name(entry.get("blood", "")), "skill": skill_name(entry["skill"])})

        hb = handbooks.get(pet.get("handbook_id"), {})
        if not hb:
            warnings.append(f"手册缺失: {key} {pet.get('title')}")
        ov = overview.get(key, {})
        season = ov.get("season")
        stats = pet.get("stats", {})
        image = pet.get("image", {}) if isinstance(pet.get("image"), dict) else {}

        pets.append(
            {
                "id": pid,
                "key": key,
                "no": pet.get("number"),
                "name": pet.get("title") or pet.get("name"),
                "species": pet.get("name"),
                "types": [type_name(t) for t in as_list(pet.get("types", {}))],
                "stats": {
                    "hp": stats.get("hp"),
                    "atk": stats.get("atk"),
                    "def": stats.get("def"),
                    "spa": stats.get("spa"),
                    "spd": stats.get("spd"),
                    "spe": stats.get("spe"),
                    "total": sum(stats.get(k, 0) for k in ("hp", "atk", "def", "spa", "spd", "spe")),
                },
                "ability": ability,
                "stage": pet.get("stage"),
                "height": (pet.get("height") or "").removesuffix("M"),
                "weight": (pet.get("weight") or "").removesuffix("KG"),
                "desc": pet.get("description"),
                "habitat": hb.get("habitat"),
                "season": None if season in (None, "none") else season,
                "pinyin": ov.get("search"),
                "avatar": image.get("head"),
                "portrait": image.get("illustration"),
                "learnset": {"level": level_out, "stone": stone_out, "bloodline": blood_out},
                "evolution_id": pet.get("evolution_id"),
            }
        )

    # 技能：只收录被精灵引用的（特性 + 学习面），与图鉴口径一致
    skills_out = []
    for key in sorted(referenced_skills):
        s = skills.get(key)
        if s is None:
            continue
        skills_out.append(
            {
                "key": key,
                "name": s.get("name"),
                "type": type_name(s.get("element", "")) if s.get("element") != "无系别" else "无",
                "category": skill_category(s),
                "power": s.get("power"),
                "energy": s.get("energy"),
                "desc": s.get("desc"),
            }
        )

    # 进化链
    conditions = data["conditions"]
    chains_out = []
    for evo_key, entry in sorted(data["evolutions"].items()):
        for obj in as_list(entry):
            stages = []
            chain = as_list(obj.get("chain", {}))
            for pos, st in enumerate(chain):
                cond = None
                if pos > 0:
                    prev_title = chain[pos - 1].get("title")
                    cond = conditions.get(prev_title, {}).get(st.get("title"))
                stages.append(
                    {
                        "pet_id": pet_id_by_key.get(st.get("id")),
                        "pet_key": st.get("id"),
                        "name": st.get("title") or st.get("name"),
                        "stage": st.get("stage"),
                        "level": st.get("level"),
                        "condition": cond,
                    }
                )
            lords = []
            for lb in seq(obj.get("lord_branches")):
                lords.append(
                    {
                        "pet_id": pet_id_by_key.get(lb.get("id")),
                        "pet_key": lb.get("id"),
                        "name": lb.get("title") or lb.get("name"),
                        "condition": lb.get("cond"),
                        "item": lb.get("item"),
                    }
                )
            chains_out.append({"key": evo_key, "name": obj.get("name"), "stages": stages, "lords": lords})

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "pets.json").write_text(json.dumps(pets, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "skills.json").write_text(json.dumps(skills_out, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "evolutions.json").write_text(
        json.dumps({"chains": chains_out}, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    # ---------- 核对 ----------
    multi = sum(1 for c in chains_out if len(c["stages"]) > 1)
    moves = sum(1 for s in skills_out if s["category"] != "特性")
    print(f"精灵 {len(pets)}（基线 662）")
    print(f"技能 {len(skills_out)}：招式 {moves}（基线 599）+ 特性 {len(skills_out) - moves}（老站未单列、本站补齐）")
    print(f"进化链 {len(chains_out)}（多成员 {multi} / 单成员 {len(chains_out) - multi}）")
    by_name = {p["name"]: p for p in pets}
    for probe in ("迪莫", "喵喵", "乐乐鲨"):
        p = by_name.get(probe)
        if p:
            print(f"  抽查 {probe}: id={p['id']} no={p['no']} 总和={p['stats']['total']} 特性={p['ability']} 技能 {len(p['learnset']['level'])}/{len(p['learnset']['stone'])}/{len(p['learnset']['bloodline'])}")
        else:
            print(f"  抽查 {probe}: 未找到！")
    投毒 = [s for s in skills_out if s["name"] == "投毒"]
    print(f"  抽查 技能·投毒: {'在库 power=' + str(投毒[0]['power']) if 投毒 else '未找到！'}")
    if warnings:
        print(f"警告 {len(warnings)} 条（前 10）：")
        for w in warnings[:10]:
            print("  -", w)
    return 0


if __name__ == "__main__":
    sys.exit(build())
