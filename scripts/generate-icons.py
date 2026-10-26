"""Generate receipt icons with Pillow only; run from any working directory."""

from pathlib import Path

from PIL import Image, ImageDraw


PRIMARY = "#2f6df6"
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "icons"


def generate(size: int, filename: str) -> None:
    # Coordinates use a 512-unit canvas. The paper's furthest corner is
    # within radius 184, comfortably inside the maskable safe radius of 204.8.
    scale = size * 4 / 512
    image = Image.new("RGB", (size * 4, size * 4), PRIMARY)
    draw = ImageDraw.Draw(image)

    def points(coords):
        return [(round(x * scale), round(y * scale)) for x, y in coords]

    paper = [(150, 106), (362, 106), (362, 386)]
    paper += [(x, 370 if i % 2 == 0 else 386)
              for i, x in enumerate(range(346, 149, -14))]
    paper += [(150, 386)]
    draw.polygon(points(paper), fill="white")
    for y, end in [(157, 322), (195, 322), (233, 286)]:
        draw.rounded_rectangle(
            (*points([(190, y)])[0], *points([(end, y + 12)])[0]),
            radius=round(6 * scale), fill=PRIMARY,
        )
    draw.line(points([(210, 302), (244, 332), (305, 276)]),
              fill=PRIMARY, width=round(17 * scale), joint="curve")
    image.resize((size, size), Image.Resampling.LANCZOS).save(OUTPUT / filename)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for size, filename in [(192, "icon-192.png"), (512, "icon-512.png"),
                           (512, "maskable-512.png")]:
        generate(size, filename)


if __name__ == "__main__":
    main()
