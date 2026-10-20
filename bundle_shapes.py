#!/usr/bin/env python3
"""
Copies Tableau shape palettes into shapes/ so the Icon and Member icons tabs
can list them when the extension is hosted as static files (GitHub Pages),
where serve.py isn't running.

    python3 bundle_shapes.py                 # Tableau Desktop's built-in palettes
    python3 bundle_shapes.py --custom        # + your "My Tableau Repository/Shapes" palettes
    python3 bundle_shapes.py DIR [DIR ...]   # these Shapes folders instead

Writes shapes/file/<palette>/<file> and shapes/index.json (same format as
serve.py's /shapes/index.json). Everything in shapes/ is published, so only add
custom palettes you are happy to share. Run stamp-versions.py and commit after.
"""
import json
import os
import shutil
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "shapes")
FILES = os.path.join(OUT, "file")
IMAGE_EXT = {".png", ".svg", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".emf", ".wmf"}
WEB_EXT = {".png", ".svg", ".jpg", ".jpeg", ".gif"}  # browsers can show these


def default_roots(custom):
    sys.path.insert(0, ROOT)
    import serve  # noqa: E402  (reuses its search for the Tableau install and repository)
    roots = serve.candidate_roots()
    if not custom:
        roots = [r for r in roots if "My Tableau Repository" not in r]
    return [r for r in roots if os.path.abspath(r) != os.path.abspath(FILES)]


def main(argv):
    custom = "--custom" in argv
    dirs = [a for a in argv if not a.startswith("--")]
    roots = dirs or default_roots(custom)
    palettes, seen = [], set()
    if os.path.isdir(FILES):
        shutil.rmtree(FILES)
    os.makedirs(FILES)
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root), key=str.lower):
            src = os.path.join(root, name)
            if not os.path.isdir(src) or name.lower() in seen:
                continue
            files = sorted((f for f in os.listdir(src)
                            if os.path.splitext(f)[1].lower() in WEB_EXT and not f.startswith(".")), key=str.lower)
            if not files:
                continue
            seen.add(name.lower())
            dst = os.path.join(FILES, name)
            os.makedirs(dst)
            for f in files:
                shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
            palettes.append({
                "name": name,
                "files": [{"name": os.path.splitext(f)[0],
                           "url": "shapes/file/" + urllib.parse.quote(name) + "/" + urllib.parse.quote(f)} for f in files],
            })
            print("  %-14s %d shapes" % (name, len(files)))
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"searched": [], "bundled": True, "palettes": palettes}, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print("Wrote shapes/index.json: %d palettes" % len(palettes))
    return 0 if palettes else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
