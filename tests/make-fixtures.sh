#!/usr/bin/env bash
# 生成导入 UI 测试用的真实 GBK 稿与 zip（需 python3 + zip）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"
rm -rf "$DIR/gbk_book" "$DIR/gbk_book.zip"; mkdir -p "$DIR/gbk_book"
python3 - "$DIR/gbk_book" <<'PY'
import os, sys
d=sys.argv[1]
chaps={"第1章 起航.txt":"第1章 起航\n\n林川睁开眼，海风灌进船舱。他攥紧拳头，暗道：这一世，绝不再让她受半分委屈。",
       "第2章 风波.txt":"第2章 风波\n\n码头人声鼎沸，一封密信悄然递来。字里行间，杀机四伏。",
       "第10章 活口.txt":"第10章 活口\n\n只留一个活口。这是规矩，也是底线。"}
for n,t in chaps.items(): open(os.path.join(d,n),"wb").write(t.encode("gbk"))
PY
( cd "$DIR/gbk_book" && zip -X -q ../gbk_book.zip *.txt )
echo "夹具已生成：$DIR/gbk_book, $DIR/gbk_book.zip（GBK 编码）"
