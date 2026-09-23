import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// Keeps titles filename-safe while staying readable: strips characters
// Windows forbids in filenames, collapses whitespace, but leaves the
// original spacing/casing alone instead of hyphenating every word.
function slugify(name) {
  return (
    name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "uncategorized"
  );
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function uniquePath(dir, slug) {
  let filePath = path.join(dir, `${slug}.md`);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${slug} ${suffix}.md`);
    suffix += 1;
  }
  return filePath;
}

function writeNote(filePath, frontmatterObj, body) {
  const frontmatter = yaml.dump(frontmatterObj, { lineWidth: -1 });
  fs.writeFileSync(filePath, `---\n${frontmatter}---\n\n${body}\n`, "utf8");
}

/**
 * Assembles frontmatter (built by code, not the model, for accuracy) plus
 * the model-generated content, and writes the journal markdown file(s).
 * When `parts` is non-empty, each part is saved as its own linked note
 * (Obsidian wikilinks) alongside a main overview note; otherwise `overview`
 * alone is saved as a single note. Returns { filePath, partFilePaths }.
 */
export function saveJournalEntry({ outputDir, classification, overview, parts, sessionId, repo, date }) {
  const categorySlug = slugify(classification.category);
  const dir = path.join(outputDir, categorySlug);
  fs.mkdirSync(dir, { recursive: true });

  const titleSlug = slugify(classification.title ?? sessionId.slice(0, 8));
  const dateStr = isoDate(date ?? new Date());

  const mainFilePath = uniquePath(dir, titleSlug);
  const mainBaseName = path.basename(mainFilePath, ".md");

  const baseFrontmatter = {
    category: classification.category,
    tags: classification.tags,
    tech_stack: classification.tech_stack,
    date: dateStr,
    session_id: sessionId,
    repo: repo ?? "unknown",
  };

  const partFilePaths = [];
  let overviewBody = overview ?? "";

  for (const [i, part] of (parts ?? []).entries()) {
    const partSlug = slugify(part.heading);
    const partFilePath = uniquePath(dir, partSlug);
    const partBaseName = path.basename(partFilePath, ".md");

    overviewBody = overviewBody.split(`[[PART:${i}]]`).join(`[[${partBaseName}|${part.heading}]]`);

    const backlink = `> [[${mainBaseName}|${classification.title}]]의 일부\n\n`;
    writeNote(partFilePath, { title: part.heading, ...baseFrontmatter }, backlink + part.body);
    partFilePaths.push(partFilePath);
  }

  writeNote(mainFilePath, { title: classification.title, ...baseFrontmatter }, overviewBody);

  return { filePath: mainFilePath, partFilePaths };
}
