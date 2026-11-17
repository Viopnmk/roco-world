#!/usr/bin/env python3
"""roco-world 数据管道 · Lua 表解析器

BWIKI nrc 的数据模块是 `return { ... }` 形式的 Lua 表字面量。
本模块把这类字面量解析成 Python 对象：
  - Lua 表 -> dict（位置元素用 1 起的整数键，与 Lua 索引一致）
  - 字符串/数字/布尔/nil -> str / int|float / bool / None

只支持数据字面量语法（标识符键、[键]、字符串、数字、布尔、nil、嵌套表），
不支持函数与表达式——数据模块里也用不到。
"""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<comment>--\[\[.*?\]\]|--[^\n]*)
  | (?P<longstr>\[\[(?:.|\n)*?\]\])
  | (?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
  | (?P<number>-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))
  | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<punct>[{}\[\]=,;])
    """,
    re.VERBOSE,
)

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0"}


def _decode_string(token: str) -> str:
    body = token[1:-1]
    if "\\" not in body:
        return body
    out = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt == "u" and i + 2 < len(body) and body[i + 2] == "{":
                end = body.index("}", i + 3)
                out.append(chr(int(body[i + 3 : end], 16)))
                i = end + 1
                continue
            if nxt.isdigit():  # \ddd 十进制转义
                j = i + 1
                while j < len(body) and body[j].isdigit() and j < i + 4:
                    j += 1
                out.append(chr(int(body[i + 1 : j])))
                i = j
                continue
            out.append(_ESCAPES.get(nxt, nxt))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _tokenize(text: str):
    pos = 0
    while pos < len(text):
        m = _TOKEN_RE.match(text, pos)
        if not m:
            raise ValueError(f"无法识别的字符 @{pos}: {text[pos:pos + 30]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind in ("ws", "comment"):
            continue
        yield kind, m.group()
    yield "eof", ""


class _Parser:
    def __init__(self, text: str):
        self.tokens = list(_tokenize(text))
        self.i = 0

    def peek(self):
        return self.tokens[self.i]

    def next(self):
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def expect_punct(self, ch: str):
        kind, val = self.next()
        if kind != "punct" or val != ch:
            raise ValueError(f"期望 {ch!r}，实际 {val!r}")

    def parse(self):
        # 允许开头的 `return`
        kind, val = self.peek()
        if kind == "name" and val == "return":
            self.next()
        value = self.parse_value()
        return value

    def parse_value(self):
        kind, val = self.peek()
        if kind == "punct" and val == "{":
            return self.parse_table()
        if kind == "string":
            self.next()
            return _decode_string(val)
        if kind == "longstr":
            self.next()
            return val[2:-2]
        if kind == "number":
            self.next()
            if val.lower().startswith(("0x", "-0x")):
                return int(val, 16)
            if any(c in val for c in ".eE"):
                return float(val)
            return int(val)
        if kind == "name":
            self.next()
            if val == "true":
                return True
            if val == "false":
                return False
            if val == "nil":
                return None
            raise ValueError(f"意外的标识符: {val!r}")
        raise ValueError(f"意外的 token: {kind} {val!r}")

    def parse_table(self):
        self.expect_punct("{")
        table: dict = {}
        auto = 0  # 位置元素计数（Lua 1 起）
        while True:
            kind, val = self.peek()
            if kind == "punct" and val == "}":
                self.next()
                return table
            # [key] = value
            if kind == "punct" and val == "[":
                save = self.i
                self.next()
                key = self.parse_value()
                self.expect_punct("]")
                if self.peek() == ("punct", "="):
                    self.next()
                    table[key] = self.parse_value()
                else:  # 只是个以 [ 开头的表达式？数据文件里不会出现，回退当位置元素
                    self.i = save
                    auto += 1
                    table[auto] = self.parse_value()
            # name = value
            elif kind == "name" and self.tokens[self.i + 1] == ("punct", "="):
                key = val
                self.next()
                self.next()
                table[key] = self.parse_value()
            else:
                auto += 1
                table[auto] = self.parse_value()
            kind, val = self.peek()
            if kind == "punct" and val in (",", ";"):
                self.next()


def parse_lua(text: str):
    """解析一个 `return { ... }` 数据模块的全文。"""
    return _Parser(text).parse()


def as_list(table):
    """若 dict 的键恰为 1..n 的整数键，转成 list；否则原样返回。"""
    if isinstance(table, dict) and table and all(isinstance(k, int) for k in table):
        n = len(table)
        if set(table.keys()) == set(range(1, n + 1)):
            return [table[i] for i in range(1, n + 1)]
    return table
