#!/usr/bin/env python3
"""roco-world 数据管道 · 性格数据：从 BWIKI nrc 拉取并生成 web/data/natures.json

数据源：https://wiki.biligame.com/nrc/ 的 Lua 数据模块「模块:Natures/data」
（「性格」页经 模板:性格 -> 模块:Natures 渲染，数据本体就在这个模块里）。

BWIKI 实测口径（2026-11-17 拉取）：
  - 共 30 种性格 = 6 种「提升属性」× 5 种「降低属性」的完整矩阵，
    没有中性（无增减）性格；
  - 提升/降低的属性包含「生命」——性格可以 +生命 或 -生命，
    与网上流传的旧版 25 种性格表（宝可梦式、无生命项）不同，以 BWIKI 为准；
  - 属性 id 对照（模块内 stats 表）：79 生命 / 80 物攻 / 81 魔攻 /
    82 物防 / 83 魔防 / 84 速度。

输出结构：[{name, plus, minus}]，plus/minus 为 pets.json stats 的键名
（hp/atk/def/spa/spd/spe）；若将来 BWIKI 出现中性性格，plus/minus 为 null。

用法：python3 scraper/fetch_natures.py [--force]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_nrc import fetch_module, RAW_DIR  # 复用第 1 步的拉取（带重试）
from lua_parse import parse_lua, as_list

TITLE = "模块:Natures/data"
OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "natures.json"

STAT_KEY = {"生命": "hp", "物攻": "atk", "魔攻": "spa",
            "物防": "def", "魔防": "spd", "速度": "spe"}


def main() -> int:
    fname = TITLE.replace("/", "_") + ".txt"
    raw_path = RAW_DIR / fname
    if raw_path.exists() and "--force" not in sys.argv:
        text = raw_path.read_text(encoding="utf-8")
        print(f"  skip {TITLE}（已缓存 {fname}）")
    else:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        text = fetch_module(TITLE)
        raw_path.write_text(text, encoding="utf-8")
        print(f"  ok {TITLE}  ({len(text):,} 字符)")

    data = parse_lua(text)
    id2key = {}
    for st in as_list(data["stats"]):
        key = STAT_KEY.get(st["name"])
        if key is None:
            raise RuntimeError(f"未知属性名: {st['name']}")
        id2key[st["id"]] = key

    rows = sorted(as_list(data["rows"]), key=lambda r: r["id"])
    natures = []
    for r in rows:
        up, down = r.get("up"), r.get("down")
        natures.append({
            "name": r["name"],
            "plus": id2key[up] if up in id2key else None,
            "minus": id2key[down] if down in id2key else None,
        })

    OUT.write_text(json.dumps(natures, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"生成 {OUT}：{len(natures)} 种性格")
    return 0


if __name__ == "__main__":
    sys.exit(main())
