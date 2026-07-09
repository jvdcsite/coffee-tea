// One-off asset prep script — NOT part of the deployed site or a build
// step. Run manually whenever new static marketing photography needs to be
// cropped/converted for site/assets/marketing/. Product photos never go
// through this script; those go through the admin upload flow instead
// (see AGENT_HANDOFF.md).
//
// Usage: node scripts/resize-marketing.js

const sharp = require("sharp");
const path = require("path");

const SRC = path.join(__dirname, "..", "site", "assets", "marketing");

const jobs = [
  // Hero slides — wide banner, max 1600px long edge.
  { in: "80D2FF3E-9A17-4A6B-B0A3-4AEFF7D809C4.png", out: "hero-1.webp", width: 1600, height: 900 },
  { in: "1B66EE8F-129E-453C-BEDC-FC81970E24D9.png", out: "hero-2.webp", width: 1600, height: 900 },
  { in: "BCAD31E8-C341-4FFE-A710-2EB7126DB09F.png", out: "hero-3.webp", width: 1600, height: 900 },

  // Category tiles — square, max 800px.
  { in: "C3A5193D-89A9-4666-9E38-CED20809C9B4.png", out: "category-coffee.webp", width: 800, height: 800 },
  { in: "1B66EE8F-129E-453C-BEDC-FC81970E24D9.png", out: "category-tea.webp", width: 800, height: 800 },

  // Brand story — landscape, fits the two-column band, max 1200px long edge.
  { in: "75E5DB2D-8631-4B32-9237-3AC9DA6E60A5.png", out: "brand-story.webp", width: 1200, height: 900 },

  // Product placeholder — blank/unbranded packaging mockup, used as a
  // front-end fallback ONLY (never written to D1's image_key/thumb_key,
  // never uploaded through the R2 admin flow) for products with no real
  // photo yet. Square, max 800px, same as a category tile.
  { in: "87CB9462-4122-4405-8060-4A49979193DA.png", out: "product-placeholder.webp", width: 800, height: 800 },
];

async function run() {
  for (const job of jobs) {
    const inPath = path.join(SRC, job.in);
    const outPath = path.join(SRC, job.out);
    await sharp(inPath)
      .resize(job.width, job.height, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toFile(outPath);
    console.log(`${job.out}  (${job.width}x${job.height})`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
