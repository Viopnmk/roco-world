#!/usr/bin/env python3
"""roco-world 数据管道 · 第 1 步：从 BWIKI nrc 拉取原始数据模块

数据源：https://wiki.biligame.com/nrc/ （MediaWiki API）
nrc 的图鉴数据不在页面正文里，而是存放在 Lua 数据模块中，分两层：
  - 基础层：模块:Pets/data/{Catalog,Skills,Learnsets,Evolutions,Handbooks,Index,Overview}
            + 模块:Pets/EvolutionConditions
  - S5 赛季层：模块:精灵图鉴/S5/数据/{精灵,技能,特性,关联,辅助}
            + 模块:精灵图鉴/S5（赛季分片的解码规范所在）

本脚本只负责「拉下来存好」，解析与合并在 build_data.py 中完成。
原始模块缓存在 scraper/raw/ 下，文件名把模块全名中的 / 换成 _。
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://wiki.biligame.com/nrc/api.php"
RAW_DIR = Path(__file__).resolve().parent / "raw"

MODULES = [
    # 基础层
    "模块:Pets/data/Catalog",
    "模块:Pets/data/Skills",
    "模块:Pets/data/Learnsets",
    "模块:Pets/data/Evolutions",
    "模块:Pets/data/Handbooks",
    "模块:Pets/data/Index",
    "模块:Pets/data/Overview",
    "模块:Pets/EvolutionConditions",
    # S5 赛季层
    "模块:精灵图鉴/S5",
    "模块:精灵图鉴/S5/配置",
    "模块:精灵图鉴/S5/数据/精灵",
    "模块:精灵图鉴/S5/数据/技能",
    "模块:精灵图鉴/S5/数据/特性",
    "模块:精灵图鉴/S5/数据/关联",
    "模块:精灵图鉴/S5/数据/辅助",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
        "Mobile/15E148 Safari/604.1"
    ),
    "Referer": "https://wiki.biligame.com/nrc/",
}


def fetch_module(title: str) -> str:
    """通过 MediaWiki API 取一个模块页面的最新 wikitext。"""
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
    req = urllib.request.Request(url, headers=HEADERS)
    data = None
    last_err = None
    for attempt in range(8):  # 出口代理偶发截断，大模块必须带重试
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except Exception as err:  # IncompleteRead / 超时 / 连接重置
            last_err = err
            time.sleep(2.0 * (attempt + 1))
    if data is None:
        raise RuntimeError(f"拉取失败（重试 8 次）: {title}: {last_err}")
    pages = data["query"]["pages"]
    if not pages or pages[0].get("missing"):
        raise RuntimeError(f"页面不存在: {title}")
    return pages[0]["revisions"][0]["slots"]["main"]["content"]


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] 开始拉取 {len(MODULES)} 个模块 -> {RAW_DIR}")
    force = "--force" in sys.argv
    for title in MODULES:
        fname = title.replace("/", "_") + ".txt"
        out = RAW_DIR / fname
        if out.exists() and not force:  # 断点续拉：已下好的不重复下
            print(f"  skip {title}（已缓存）")
            continue
        text = fetch_module(title)
        out.write_text(text, encoding="utf-8")
        print(f"  ok {title}  ({len(text):,} 字符)")
        time.sleep(0.4)  # 礼貌间隔
    print("全部拉取完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
