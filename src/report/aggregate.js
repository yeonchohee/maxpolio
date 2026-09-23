import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logger } from "../lib/logger.js";

function walkMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "reports") continue; // don't count our own generated reports
      results.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return null;
  const yamlBlock = raw.slice(4, end);
  try {
    return yaml.load(yamlBlock);
  } catch (err) {
    logger.warn("failed to parse frontmatter", { error: err.message, filePath });
    return null;
  }
}

function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Scans `outputDir` for journal entries and aggregates category/tag/
 * tech-stack counts plus recent-activity trends.
 */
export function aggregateJournal(outputDir) {
  const files = walkMarkdownFiles(outputDir);

  const categoryCounts = new Map();
  const tagCounts = new Map();
  const techStackCounts = new Map();
  const entries = [];

  for (const file of files) {
    const fm = parseFrontmatter(file);
    if (!fm) continue;

    bump(categoryCounts, fm.category);
    for (const tag of fm.tags ?? []) bump(tagCounts, tag);
    for (const tech of fm.tech_stack ?? []) bump(techStackCounts, tech);

    entries.push({
      category: fm.category,
      date: fm.date,
      tags: fm.tags ?? [],
      tech_stack: fm.tech_stack ?? [],
    });
  }

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const withinDays = (days) => (e) => e.date && now - new Date(e.date).getTime() <= days * DAY;

  const last30 = entries.filter(withinDays(30));
  const last90 = entries.filter(withinDays(90));

  const countByCategory = (list) => {
    const m = new Map();
    for (const e of list) bump(m, e.category);
    return Object.fromEntries(m);
  };

  return {
    totalCount: entries.length,
    categoryCounts: Object.fromEntries(categoryCounts),
    tagCounts: Object.fromEntries(tagCounts),
    techStackCounts: Object.fromEntries(techStackCounts),
    trend: {
      last30: { count: last30.length, byCategory: countByCategory(last30) },
      last90: { count: last90.length, byCategory: countByCategory(last90) },
    },
  };
}
