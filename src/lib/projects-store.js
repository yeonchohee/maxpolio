import fs from "node:fs";
import { MAXPOLIO_HOME, PROJECTS_PATH } from "./paths.js";
import { logger } from "./logger.js";

/**
 * Projects are the second axis next to the fixed tech categories. Unlike
 * categories they grow over time, so they live in ~/.maxpolio/projects.json:
 * [{ name, description, repos: ["ssf-dashboard", ...] }].
 */
export function loadProjects() {
  if (!fs.existsSync(PROJECTS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error("failed to parse projects.json", { error: err });
    return [];
  }
}

function saveProjects(projects) {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2) + "\n", "utf8");
}

// "http://host/group/ssf-dashboard.git" and a plain "ssf-dashboard" folder
// name (repo without a remote) both become "ssf-dashboard".
export function repoKeyOf(repo) {
  if (!repo || repo === "unknown") return null;
  return repo.split(/[\\/]/).filter(Boolean).pop().replace(/\.git$/, "").toLowerCase() || null;
}

export function findProjectByRepo(projects, repo) {
  const key = repoKeyOf(repo);
  return key ? (projects.find((p) => (p.repos ?? []).includes(key)) ?? null) : null;
}

/**
 * Adds the project if it is new and links the repo to it, so later
 * sessions in the same repo land in the same project without asking.
 */
export function recordProject(name, { repo, description } = {}) {
  if (!name) return;
  const projects = loadProjects();
  let project = projects.find((p) => p.name === name);
  if (!project) {
    project = { name, description: description ?? "", repos: [] };
    projects.push(project);
  }
  const key = repoKeyOf(repo);
  if (key && !projects.some((p) => (p.repos ?? []).includes(key))) {
    project.repos = [...(project.repos ?? []), key];
  }
  saveProjects(projects);
}
