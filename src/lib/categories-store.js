import fs from "node:fs";
import { CATEGORIES_PATH, MAXPOLIO_HOME } from "./paths.js";
import { logger } from "./logger.js";

export function loadCategories() {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  if (!fs.existsSync(CATEGORIES_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error("failed to parse categories.json", { error: err });
    return [];
  }
}

function saveCategories(categories) {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2) + "\n", "utf8");
}

/**
 * Records a category usage. If `description` is provided and the category
 * is new, it is added to the store; otherwise the existing entry's count
 * and lastUsedAt are bumped.
 */
export function recordCategoryUsage(name, description) {
  const categories = loadCategories();
  const existing = categories.find((c) => c.name === name);
  const now = new Date().toISOString();

  if (existing) {
    existing.count = (existing.count ?? 0) + 1;
    existing.lastUsedAt = now;
  } else {
    categories.push({
      name,
      description: description ?? "",
      count: 1,
      lastUsedAt: now,
    });
  }

  saveCategories(categories);
  return categories;
}
