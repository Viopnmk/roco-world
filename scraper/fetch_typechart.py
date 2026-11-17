#!/usr/bin/env python3
"""roco-world 数据管道 · 属性克制表：从 BWIKI nrc 生成 web/data/typechart.json

数据源：BWIKI《洛克王国：世界》「克制计算器」背后的结构化数据模块
  模块:Pets/data/Types（BWIKI 的 Module:TypeData 从这里组装克制计算器，
  模块页注明「根据当前游戏数据生成」）

原模块是「守方导向」：键为守方属性（单系如 "冰系"，双系如 "冰系|地系"），
值含 weak（受到的克制，倍率 2 或双重弱点 3）与 resist（抵抗，倍率 0.5 或
双重抵抗 0.25）两张表。本脚本把它转置成「攻方导向」的 18×18 矩阵。

本作的双系合并规则不是简单相乘，而是「步进规则」（已用模块自带的 102 条
双系组合全量验证，1836 格零误差）：
  每个守方属性贡献一步：被克制 +1 步、被抵抗 -1 步、无关 0 步；
  两步合计查表：+2 -> ×3（双重弱点）、+1 -> ×2、0 -> ×1、
                -1 -> ×0.5、-2 -> ×0.25（双重抵抗）。
本作没有任何属性免疫（不存在 ×0）：如电打地、幽灵打普通都只是 ×0.5。

名称对齐：BWIKI 写「幽系」，本站 pets.json 写「幽灵」，生成时统一成「幽灵」。

产物：web/data/typechart.json —— {攻方属性: {守方属性: 倍率}}，18×18 全格。
原始模块同时缓存到 scraper/raw/模块_Pets_data_Types.txt。

用法：python3 scraper/fetch_typechart.py [--force]
网络走环境变量里的代理（http_proxy/https_proxy），urllib 自动读取。
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lua_parse import parse_lua, as_list  # noqa: E402

API = "https://wiki.biligame.com/nrc/api.php"
ROOT = Path(__file__).resolve().parent.parent
RAW_FILE = Path(__file__).resolve().parent / "raw" / "模块_Pets_data_Types.txt"
OUT_JSON = ROOT / "web" / "data" / "typechart.json"
MODULE = "模块:Pets/data/Types"

HEADERS = {
    "User-Agent": "roco-world-scraper/1.0",
    "Referer": "https://wiki.biligame.com/nrc/",
}

TYPES18 = ["普通", "火", "水", "草", "电", "冰", "地", "龙", "毒", "虫",
           "武", "翼", "萌", "幽灵", "恶", "机械", "幻", "光"]

STEP_OF = {3: 2, 2: 1, 1: 0, 0.5: -1, 0.25: -2}
MULT_OF_STEP = {2: 3, 1: 2, 0: 1, -1: 0.5, -2: 0.25}


def fetch_module(title: str) -> str:
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "titles": title,
        "format": "json",
        "formatversion": "2",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            pages = data["query"]["pages"]
            if not pages or pages[0].get("missing"):
                raise RuntimeError(f"页面不存在: {title}")
            return pages[0]["revisions"][0]["slots"]["main"]["content"]
        except Exception as err:
            last_err = err
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"拉取失败（重试 6 次）: {title}: {last_err}")


def short(name: str) -> str:
    """'幽系' -> '幽灵'，'火系' -> '火'（对齐本站属性名）。"""
    n = name[:-1] if name.endswith("系") else name
    return "幽灵" if n == "幽" else n


def main() -> int:
    force = "--force" in sys.argv
    if RAW_FILE.exists() and not force:
        text = RAW_FILE.read_text(encoding="utf-8")
        print(f"使用缓存 {RAW_FILE.name}（{len(text):,} 字符，--force 可刷新）")
    else:
        text = fetch_module(MODULE)
        RAW_FILE.parent.mkdir(parents=True, exist_ok=True)
        RAW_FILE.write_text(text, encoding="utf-8")
        print(f"已拉取 {MODULE}（{len(text):,} 字符）-> {RAW_FILE.name}")

    data = parse_lua(text)

    # 1) 单系：守方导向 -> 转置成攻方导向 chart[攻][守]
    chart = {a: {d: 1 for d in TYPES18} for a in TYPES18}
    singles = 0
    for key, val in data.items():
        if "|" in key:
            continue
        singles += 1
        defender = short(key)
        for kind in ("weak", "resist"):
            for item in as_list(val.get(kind) or {}):
                chart[short(item["type"])][defender] = item["multiplier"]
    if singles != 18:
        raise RuntimeError(f"单系条目应为 18，实际 {singles}")

    # 2) 用模块自带的双系组合全量验证步进规则
    checked = mismatched = duals = 0
    for key, val in data.items():
        if "|" not in key:
            continue
        duals += 1
        parts = [short(x) for x in key.split("|")]
        listed = {}
        for kind in ("weak", "resist"):
            for item in as_list(val.get(kind) or {}):
                listed[short(item["type"])] = item["multiplier"]
        for atk in TYPES18:
            expect = MULT_OF_STEP[STEP_OF[chart[atk][parts[0]]] + STEP_OF[chart[atk][parts[1]]]]
            checked += 1
            if expect != listed.get(atk, 1):
                mismatched += 1
                print(f"  步进规则不符：{key} 受 {atk}，期望 {expect}，模块 {listed.get(atk, 1)}")
    print(f"双系组合 {duals} 条、共 {checked} 格，步进规则不符 {mismatched} 格")
    if mismatched:
        raise RuntimeError("步进规则验证未通过，不生成产物")

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(chart, f, ensure_ascii=False, indent=1, sort_keys=False)
    print(f"完成：{OUT_JSON}（18 攻方 × 18 守方 = 324 格）")
    for a, d in [("火", "草"), ("水", "火"), ("草", "水"), ("电", "水"), ("电", "地"),
                 ("冰", "龙"), ("武", "普通"), ("幽灵", "普通"), ("毒", "草"), ("龙", "龙")]:
        print(f"  抽查 {a} -> {d} = {chart[a][d]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
