/// <reference types="node" />
// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships an installable manifest and PNG icons with matching dimensions", () => {
  const publicRoot = new URL("../public/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", publicRoot), "utf8"));
  expect(manifest).toMatchObject({
    id: "/", name: "領収書保管 Receipt Vault", short_name: "領収書保管",
    lang: "ja", start_url: "/", scope: "/", display: "standalone",
    theme_color: "#2f6df6", background_color: "#f6f7f9",
    prefer_related_applications: false,
  });
  expect(manifest).not.toHaveProperty("orientation");
  expect(manifest.icons).toEqual([
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(icon.src.slice(1), publicRoot));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }
});
