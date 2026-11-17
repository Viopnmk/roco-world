#!/usr/bin/env python3
"""把 pets.json 里的 avatar / portrait 文件名解析成 patchwiki 图片直链。

通过 BWIKI（wiki.biligame.com/nrc）的 MediaWiki API 批量查询：
  api.php?action=query&titles=File:<文件名>&prop=imageinfo&iiprop=url&iiurlwidth=512

注意：API 会把标题 normalize（"File:PetAvatar_3004.png" ->
"文件:PetAvatar 3004.png"，下划线变空格、英文 File: 变中文 文件:），
返回的 normalized 映射必须用来把 page 对回原始文件名。

产物：web/data/images.json
  { "PetAvatar_3004.png": {"url": <原图直链>, "thumb": <512 宽缩略图直链>}, ... }
查不到的文件不写入，前端会回退到 Special:FilePath。

用法：python3 scraper/fetch_images.py
网络走环境变量里的代理（http_proxy/https_proxy），urllib 自动读取。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PETS_JSON = os.path.join(ROOT, "web", "data", "pets.json")
OUT_JSON = os.path.join(ROOT, "web", "data", "images.json")
API = "https://wiki.biligame.com/nrc/api.php"
BATCH = 50  # MediaWiki API 单次 titles 上限
RETRIES = 4


def fetch_batch(filenames):
    """查一批文件名，返回 {原文件名: {"url":..., "thumb":...}}，查不到的不含。"""
    titles = "|".join("File:" + fn for fn in filenames)
    params = {
        "action": "query",
        "titles": titles,
        "prop": "imageinfo",
        "iiprop": "url",
        "iiurlwidth": "512",
        "format": "json",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "roco-world-scraper/1.0"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except Exception as e:  # 网络抖动重试
            last_err = e
            wait = 2 ** attempt
            print(f"  请求失败（第 {attempt + 1} 次）：{e}，{wait}s 后重试", file=sys.stderr)
            time.sleep(wait)
    else:
        raise RuntimeError(f"批次查询多次失败：{last_err}")

    query = data.get("query", {})
    # normalized: {"from": "File:X.png", "to": "文件:X Y.png"}，用它对回原名
    norm = {n["from"]: n["to"] for n in query.get("normalized", [])}
    pages_by_title = {}
    for page in query.get("pages", {}).values():
        pages_by_title[page.get("title", "")] = page

    out = {}
    for fn in filenames:
        title = "File:" + fn
        title = norm.get(title, title)
        page = pages_by_title.get(title)
        if not page or "missing" in page:
            continue
        info = (page.get("imageinfo") or [{}])[0]
        if not info.get("url"):
            continue
        out[fn] = {"url": info["url"], "thumb": info.get("thumburl") or info["url"]}
    return out


def main():
    with open(PETS_JSON, encoding="utf-8") as f:
        pets = json.load(f)

    filenames = []
    seen = set()
    for pet in pets:
        for field in ("avatar", "portrait"):
            fn = pet.get(field)
            if fn and fn not in seen:
                seen.add(fn)
                filenames.append(fn)
    print(f"精灵 {len(pets)} 只，去重后待查图片 {len(filenames)} 个")

    images = {}
    missing = []
    for i in range(0, len(filenames), BATCH):
        batch = filenames[i : i + BATCH]
        got = fetch_batch(batch)
        images.update(got)
        missing.extend(fn for fn in batch if fn not in got)
        print(f"  进度 {min(i + BATCH, len(filenames))}/{len(filenames)}，已解析 {len(images)}")
        time.sleep(0.3)

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(images, f, ensure_ascii=False, indent=1, sort_keys=True)

    total_slots = sum(1 for p in pets for k in ("avatar", "portrait") if p.get(k))
    covered_slots = sum(
        1 for p in pets for k in ("avatar", "portrait") if p.get(k) in images
    )
    print(f"\n完成：{OUT_JSON}")
    print(f"唯一文件名覆盖：{len(images)}/{len(filenames)}")
    print(f"精灵图片位覆盖：{covered_slots}/{total_slots}（662 只 × 头像+立绘）")
    if missing:
        print(f"未解析到直链的文件（{len(missing)} 个，前端将回退 Special:FilePath）：")
        for fn in missing:
            print("  -", fn)


if __name__ == "__main__":
    main()
