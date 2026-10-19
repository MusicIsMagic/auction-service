#!/usr/bin/env python3
"""Print the three image-generation prompts for a site: cards sheet (3x3), seasons sheet (2x2), hero."""
import sys, pathlib, importlib.util
HERE = pathlib.Path(__file__).parent
key = sys.argv[1]
spec = importlib.util.spec_from_file_location("c", HERE / "content" / (key + ".py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
S = m.SITE
P = S["photos"]
style = P["style"]
cells = [t["photo"] for t in S["topics"][:6]] + [S["hiring"]["photo"]] + P["spare"][:2]
GRID = ("Create ONE single image that is a clean contact sheet: a {cols} by {rows} grid of {n} separate photographs, all exactly the same size and aspect ratio (4:3 landscape), "
        "edge to edge with no borders, no gaps, no frames, no captions, no numbers, no text anywhere. Each cell is its own complete photograph with its own subject and composition. "
        "Style for every cell: {style}. Cells in reading order, left to right, top to bottom:\n")
out = ["=== PROMPT 1 of 3: save as cards.png ===\n" + GRID.format(cols=3, rows=3, n=9, style=style)
       + "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(cells))]
out.append("=== PROMPT 2 of 3: save as seasons.png ===\n" + GRID.format(cols=2, rows=2, n=4, style=style)
           + "\n".join("%d. %s (%s)" % (i + 1, t["photo"], t["title"].lower()) for i, t in enumerate(S["timing"][:4])))
out.append("=== PROMPT 3 of 3: save as hero.png ===\nA single wide cinematic photograph, 16:9 landscape, no text, no logos, no people. Style: %s. Scene: %s." % (style, P["hero"]))
txt = "\n\n".join(out) + "\n\nSave the three files and send them to me, or drop them in the chat.\n"
d = HERE / "prompts"; d.mkdir(exist_ok=True)
(d / (key + "-image-prompts.txt")).write_text(txt)
print(txt)
