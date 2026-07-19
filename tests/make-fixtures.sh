#!/usr/bin/env bash
# 生成导入 UI 测试用的真实夹具（需 python3 + zip）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"

# ① 纯 GBK 稿 + zip（文件名与正文均 GBK）
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

# ② 混编码 + 垃圾文件 zip：GBK / UTF-8 / UTF-16LE 各一章 + 应被过滤的垃圾
rm -rf "$DIR/messy" "$DIR/messy.zip"; mkdir -p "$DIR/messy/__MACOSX"
python3 - "$DIR/messy" <<'PY'
import os, sys
d=sys.argv[1]
open(os.path.join(d,"第1章 起航.txt"),"wb").write("第1章 起航\n\n林川睁开眼，海风灌进船舱。".encode("gbk"))          # GBK
open(os.path.join(d,"第2章 风波.txt"),"wb").write("第2章 风波\n\n一封密信悄然递来，杀机四伏。".encode("utf-8"))       # UTF-8
open(os.path.join(d,"第3章 密信.txt"),"wb").write(b"\xff\xfe"+"第3章 密信\n\n信纸展开，只有八个字。".encode("utf-16-le"))  # UTF-16LE 带 BOM(真实 Windows「Unicode 另存」)
open(os.path.join(d,"cover.jpg"),"wb").write(b"\xff\xd8\xff\xe0JUNK-NOT-A-CHAPTER")                                    # 非章节
open(os.path.join(d,".hidden.txt"),"wb").write("隐藏文件不该导入".encode("utf-8"))                                     # 隐藏
open(os.path.join(d,"__MACOSX","._第1章 起航.txt"),"wb").write(b"\x00\x05\x16\x07macos-metadata")                     # macOS 元数据
PY
( cd "$DIR/messy" && zip -X -q -r ../messy.zip . )
echo "夹具已生成：gbk_book(.zip) 纯GBK；messy.zip 混编码+垃圾（GBK/UTF-8/UTF-16LE 各一章 + 应过滤 3 个）"
