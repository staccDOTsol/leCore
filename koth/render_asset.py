"""Render a King of the Hill card as a creature with leCore: the token's numbers grow the body.

Reads the card JSON (koth/src/cards.ts shape) on stdin, writes a PNG to argv[1]. The creature spec
inside the card was derived deterministically from the token's metrics -- liquidity lengthens the
spine, volatility lengthens the limbs, distribution thickens them, buy pressure lifts the head --
so two snapshots of the same token at different moments are visibly different animals.

Everything goes through UnifiedMind faculties, the same chain demo_creatures.py uses:
spec -> rig -> metaball skin -> mesh -> fit_camera -> render_mesh.
"""
import json
import os
import sys

import numpy as np

# The engine lives one directory up (the leCore repo root); make the script runnable from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lecore  # noqa: E402
from holographic.rendering.holographic_render import Light


def spec_from_card(m, card):
    cr = card["creature"]
    spec = m.quadruped_spec()
    want = int(cr["spine"]["segments"])
    have = int(spec["spine"]["segments"])
    if want > have:
        spec = m.extend_spine(spec, want - have)
    spec = m.reshape_spine(spec, length=float(cr["spine"]["length"]), curve=float(cr["spine"]["curve"]))
    # a belly profile that peaks mid-spine; HP (liquidity) widens it. One radius per spine NODE.
    nodes = int(spec["spine"]["segments"]) + 1
    hp = card["stats"]["hp"] / 100.0
    radii = [0.06 + (0.10 + 0.08 * hp) * np.sin(np.pi * (i + 0.5) / nodes) for i in range(nodes)]
    spec = m.spine_profile(spec, [float(r) for r in radii])
    limbs = []
    for l in cr["limbs"]:
        limbs.append({"at": float(l["at"]), "dir": [0.6, -1.4, -0.2], "segments": int(l["segments"]),
                      "length": float(l["length"]), "radius": float(l["radius"]), "mirror": True})
    spec["limbs"] = limbs
    spec["head"] = {"at": 1.0, "radius": float(cr["head"]["radius"])}
    return spec


def paint(V, card, seed):
    """Per-vertex albedo: the element tint, patterned along the spine axis (x) by rarity."""
    cr = card["creature"]
    base = np.asarray(cr["tint"], float)
    x = V[:, 0]
    span = max(float(x.max() - x.min()), 1e-6)
    t = (x - x.min()) / span
    cols = np.tile(base, (len(V), 1))
    pat = cr["pattern"]
    if pat == "stripes":
        mask = (np.sin(t * 22.0) > 0.55)
    elif pat == "bands":
        mask = (np.sin(t * 9.0) > 0.0)
    elif pat == "spots":
        rng = np.random.default_rng(seed)
        centers = rng.uniform(V.min(0), V.max(0), size=(18, 3))
        d = np.linalg.norm(V[:, None, :] - centers[None, :, :], axis=-1).min(1)
        mask = d < 0.09
    else:
        mask = np.zeros(len(V), bool)
    cols[mask] = cols[mask] * 0.45
    # a lighter belly: vertices below the spine midline
    below = V[:, 2] < np.median(V[:, 2])
    cols[below] = np.clip(cols[below] * 1.25 + 0.05, 0, 1)
    return np.clip(cols, 0, 1)


def main():
    out = sys.argv[1]
    card = json.load(sys.stdin)
    seed = int(card["seed"][:8], 16) % (2 ** 31)
    m = lecore.UnifiedMind(dim=256, seed=seed % 1000)
    spec = spec_from_card(m, card)
    cr = m.creature(spec, skin=False)
    mesh = m.creature_skin_mesh(cr, spec, spacing=0.9, resolution=int(sys.argv[2]) if len(sys.argv) > 2 else 80)
    V = np.asarray(mesh.vertices, float)
    cols = paint(V, card, seed)
    size = 720
    lights = [Light("directional", direction=(-0.55, 0.6, -0.55), intensity=1.25),
              Light("directional", direction=(0.7, 0.35, -0.2), intensity=0.45)]
    cam = m.fit_camera(mesh, direction=(0.8, -1.0, 0.45), up=(0.0, 0.0, 1.0), fov_deg=40.0,
                       width=size, height=size, margin=1.12)
    bg = (0.05, 0.06, 0.08)
    img = m.render_mesh(mesh, cam, width=size, height=size, vertex_colors=cols, lights=lights,
                        ambient=0.45, background=bg, smooth=True)
    m.save_render(out, np.clip(np.asarray(img), 0, 1))
    print(json.dumps({"ok": True, "vertices": int(len(V)), "faces": int(len(mesh.faces))}))


if __name__ == "__main__":
    main()
