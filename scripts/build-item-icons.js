const fs = require("node:fs");
const vm = require("node:vm");
const esbuild = require("esbuild");
// Canvas and SVG use the same trusted vector definitions.
const context = { module: { exports: {} } };
vm.runInNewContext(
  esbuild.transformSync(fs.readFileSync("shared/itemIcons.ts", "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code,
  context,
);
const icons = context.module.exports.ITEM_ICONS;
const folder = "public/assets/images/items";
fs.mkdirSync(folder, { recursive: true });
for (const [kind, icon] of Object.entries(icons)) {
  const background = ["meteor", "barrier", "slime"].includes(kind)
    ? "#352b2e"
    : "#15303d";
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 80">',
  ];
  if (icon.frame !== false)
    parts.push(
      `<rect x="1.5" y="1.5" width="61" height="61" rx="13" fill="${background}" stroke="${icon.color}" stroke-width="2"/>`,
    );
  for (const shape of icon.paths)
    parts.push(
      `<path d="${shape.d}" fill="${shape.fill ?? "none"}" stroke="${shape.stroke ?? icon.color}" stroke-width="${shape.width ?? 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  if (kind === "multiplier")
    parts.push(
      '<text x="34" y="48" text-anchor="middle" font-family="sans-serif" font-size="27" font-weight="bold" fill="#eee0ff">×2</text>',
    );
  else if (icon.value)
    parts.push(
      `<rect x="15" y="58" width="34" height="21" rx="7" fill="#10252f" stroke="${icon.color}" stroke-width="1.5"/><text x="32" y="74" text-anchor="middle" font-family="sans-serif" font-size="17" font-weight="bold" fill="${icon.color}">${icon.value}</text>`,
    );
  fs.writeFileSync(`${folder}/${kind}.svg`, parts.join("") + "</svg>\n");
}
