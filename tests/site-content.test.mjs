import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const docsRoot = path.join(root, "src/content/docs");
const dataPath = path.join(root, "src/data/maturity-items.json");

const expectedTitles = [
  "Default ServiceAccount 사용을 제한하고 불필요한 토큰 마운트를 비활성화한다",
  "컨테이너를 non-root 사용자로 실행하고 루트 파일시스템 쓰기를 제한한다",
  "Public API endpoint 접근 CIDR을 신뢰 구간으로 제한한다",
  "Ingress와 Load Balancer에서 TLS를 강제한다",
  "Kubernetes API endpoint를 private-only로 전환한다",
  "Worker node와 Pod를 private subnet에 배치한다",
  "기본 deny NetworkPolicy를 적용한다",
  "외부 진입점 TLS 인증서를 자동 관리한다",
  "Workload 내 Hardcoded Secret을 제거한다",
  "컨테이너 이미지를 배포 전 스캔하고 Critical/High 취약점 배포를 차단한다",
  "Namespace별 ResourceQuota와 LimitRange를 적용한다",
];

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(current);
    return /\.(md|mdx)$/.test(entry.name) ? [current] : [];
  });
}

test("all existing model items are migrated into Starlight docs", () => {
  const files = listMarkdownFiles(docsRoot);
  const corpus = files.map((file) => readFileSync(file, "utf8")).join("\n");

  for (const title of expectedTitles) {
    assert.match(corpus, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("maturity data includes each item once with normalized metadata", () => {
  assert.equal(existsSync(dataPath), true);
  const items = JSON.parse(readFileSync(dataPath, "utf8"));
  const titles = items.map((item) => item.title);

  assert.equal(items.length, expectedTitles.length);
  assert.deepEqual([...new Set(titles)].sort(), [...expectedTitles].sort());

  for (const item of items) {
    assert.match(item.href, /^\/(quick-wins|foundational)\//);
    assert.match(item.phase, /^(Quick Wins|Foundational)$/);
    assert.ok(item.domain.length > 0);
    assert.ok(item.difficulty.length > 0);
  }
});

test("GitHub Pages and design integration files are present", () => {
  const files = [
    "astro.config.mjs",
    "tsconfig.json",
    "src/styles/custom.css",
    "src/components/MaturityMatrix.astro",
    ".github/workflows/deploy.yml",
  ];

  for (const file of files) {
    assert.equal(existsSync(path.join(root, file)), true, `${file} should exist`);
  }
});

test("maturity matrix joins the GitHub Pages base path and item href safely", () => {
  const component = readFileSync(path.join(root, "src/components/MaturityMatrix.astro"), "utf8");

  assert.match(component, /base\.endsWith\("\/"\)/);
  assert.doesNotMatch(component, /\$\{base\}\$\{href/);
});

test("root redirect joins the GitHub Pages base path safely", () => {
  const page = readFileSync(path.join(root, "src/pages/index.astro"), "utf8");

  assert.match(page, /base\.endsWith\("\/"\)/);
  assert.match(page, /`\$\{basePath\}0-introduction\/`/);
  assert.doesNotMatch(page, /\$\{import\.meta\.env\.BASE_URL\}0-introduction/);
});

test("Starlight table of contents is disabled for wider content pages", () => {
  const config = readFileSync(path.join(root, "astro.config.mjs"), "utf8");

  assert.match(config, /tableOfContents:\s*false/);
});

test("maturity model board supports phase and domain filtering controls", () => {
  const component = readFileSync(path.join(root, "src/components/MaturityMatrix.astro"), "utf8");
  const styles = readFileSync(path.join(root, "src/styles/custom.css"), "utf8");

  assert.match(component, /data-maturity-toolbar/);
  assert.match(component, /data-filter-type="phase"/);
  assert.match(component, /data-filter-type="domain"/);
  assert.match(component, /data-phase-col/);
  assert.match(component, /data-phase-cell/);
  assert.match(component, /selectedPhase/);
  assert.match(styles, /\.maturity-board/);
  assert.match(styles, /\.maturity-card-code/);
});

test("content layout uses the full width beside the sidebar", () => {
  const styles = readFileSync(path.join(root, "src/styles/custom.css"), "utf8");

  assert.match(styles, /--sl-content-width:\s*min\(100%,\s*calc\(100vw - var\(--sl-sidebar-width\)/);
  assert.match(styles, /\.content-panel/);
  assert.match(styles, /--sl-content-margin-inline:\s*0/);
});
