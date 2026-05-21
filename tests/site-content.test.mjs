import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const docsRoot = path.join(root, "src/content/docs");
const dataPath = path.join(root, "src/data/maturity-items.json");

const sourceDomains = ["접근 제어", "네트워크 보안", "데이터 보호", "Pod 보안"];
const phaseDirectoryNames = new Map([
  ["QuickWins", "Quick Wins"],
  ["Foundational", "Foundational"],
  ["foundational", "Foundational"],
  ["Efficient", "Efficient"],
  ["Optimized", "Optimized"],
]);

function titleFrom(markdown) {
  const firstLine = markdown.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/^#\s+/, "").trim();
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(current);
    return /\.(md|mdx)$/.test(entry.name) ? [current] : [];
  });
}

function sourceMarkdownFiles() {
  return sourceDomains.flatMap((domain) => {
    const domainDir = path.join(root, domain);
    return listMarkdownFiles(domainDir).filter((file) => {
      const relative = path.relative(domainDir, file);
      const [phaseDir] = relative.split(path.sep);
      return phaseDirectoryNames.has(phaseDir);
    });
  });
}

const expectedItems = sourceMarkdownFiles().map((file) => {
  const relative = path.relative(root, file);
  const [domain, phaseDir] = relative.split(path.sep);
  return {
    title: titleFrom(readFileSync(file, "utf8")),
    phase: phaseDirectoryNames.get(phaseDir),
    domain,
  };
});

const expectedTitles = expectedItems.map((item) => item.title);

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
    assert.match(item.href, /^\/(quick-wins|foundational|efficient|optimized)\//);
    assert.match(item.phase, /^(Quick Wins|Foundational|Efficient|Optimized)$/);
    assert.ok(item.domain.length > 0);
    assert.ok(item.difficulty.length > 0);
  }

  for (const expected of expectedItems) {
    assert.ok(
      items.some(
        (item) =>
          item.title === expected.title &&
          item.phase === expected.phase &&
          item.domain === expected.domain,
      ),
      `${expected.title} should keep source phase and domain metadata`,
    );
  }
});

test("latest source phase and domain moves are reflected without changing stable slugs", () => {
  const items = JSON.parse(readFileSync(dataPath, "utf8"));
  const podIam = items.find((item) => item.title === "Pod별 IAM Role 부여를 통해 워크로드별 AWS 권한을 분리한다");
  const nonRoot = items.find((item) => item.title === "컨테이너를 non-root 사용자로 실행하고 루트 파일시스템 쓰기를 제한한다");

  assert.deepEqual(
    {
      phase: podIam?.phase,
      domain: podIam?.domain,
      href: podIam?.href,
    },
    {
      phase: "Foundational",
      domain: "접근 제어",
      href: "/foundational/pod별-iam-role-부여",
    },
  );
  assert.equal(existsSync(path.join(docsRoot, "foundational", "pod별-iam-role-부여.md")), true);
  assert.equal(existsSync(path.join(docsRoot, "efficient", "pod별-iam-role-부여.md")), false);

  assert.deepEqual(
    {
      phase: nonRoot?.phase,
      domain: nonRoot?.domain,
      href: nonRoot?.href,
    },
    {
      phase: "Quick Wins",
      domain: "Pod 보안",
      href: "/quick-wins/non-root-containers",
    },
  );
  assert.equal(existsSync(path.join(docsRoot, "quick-wins", "non-root-containers.md")), true);
  assert.equal(existsSync(path.join(docsRoot, "quick-wins", "container-root-권한-실행-제한.md")), false);
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

test("bottom domain-specific view is removed from navigation and content", () => {
  const config = readFileSync(path.join(root, "astro.config.mjs"), "utf8");

  assert.doesNotMatch(config, /영역별 보기/);
  assert.equal(existsSync(path.join(docsRoot, "domains")), false);
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

test("maturity model renders a table-only domain by phase matrix view", () => {
  const component = readFileSync(path.join(root, "src/components/MaturityMatrix.astro"), "utf8");
  const styles = readFileSync(path.join(root, "src/styles/custom.css"), "utf8");
  const model = readFileSync(path.join(docsRoot, "model.mdx"), "utf8");

  assert.doesNotMatch(component, /data-maturity-toolbar/);
  assert.doesNotMatch(component, /data-filter-type="phase"/);
  assert.doesNotMatch(component, /data-filter-type="domain"/);
  assert.doesNotMatch(component, /maturity-card-code/);
  assert.doesNotMatch(component, /difficulty-badge/);
  assert.doesNotMatch(component, /itemCode/);
  assert.doesNotMatch(component, /selectedPhase/);
  assert.match(component, /maturity-meta/);
  assert.match(component, /phase-badge/);
  assert.match(component, /item-badge/);
  assert.match(component, /단계:/);
  assert.match(component, /항목:/);
  assert.match(component, /data-phase-col/);
  assert.match(component, /data-phase-cell/);
  assert.match(component, /layout === "phase-domain"/);
  assert.doesNotMatch(component, /data-phase-difficulty-table/);
  assert.match(styles, /\.maturity-board/);
  assert.match(styles, /\.maturity-meta/);
  assert.match(styles, /\.phase-badge/);
  assert.match(styles, /\.item-badge/);
  assert.doesNotMatch(styles, /\.maturity-toolbar/);
  assert.doesNotMatch(styles, /\.maturity-card-code/);
  assert.doesNotMatch(styles, /\.difficulty-badge/);
  assert.match(model, /행은 보안 영역/);
  assert.match(model, /열은 성숙도 단계/);
  assert.doesNotMatch(model, /필터/);
});

test("phase index pages use transposed table-only matrix views", () => {
  assert.equal(existsSync(path.join(root, "src/components/PhaseDifficultyMatrix.astro")), false);

  for (const slug of ["quick-wins", "foundational", "efficient", "optimized"]) {
    const page = readFileSync(path.join(docsRoot, slug, "index.mdx"), "utf8");

    assert.match(page, /import MaturityMatrix/);
    assert.match(page, /<MaturityMatrix initialPhase=/);
    assert.match(page, /layout="phase-domain"/);
    assert.doesNotMatch(page, /난이도 기준/);
    assert.doesNotMatch(page, /난이도별 보안 영역 매트릭스/);
    assert.doesNotMatch(page, /행은 난이도/);
  }
});

test("generated docs do not include difficulty criteria tables", () => {
  const files = listMarkdownFiles(docsRoot);
  const corpus = files.map((file) => readFileSync(file, "utf8")).join("\n");

  assert.doesNotMatch(corpus, /## 난이도 기준/);
  assert.doesNotMatch(corpus, /data-phase-difficulty-table/);
  assert.doesNotMatch(corpus, /PhaseDifficultyMatrix/);
  for (const slug of ["quick-wins", "foundational", "efficient", "optimized"]) {
    const page = readFileSync(path.join(docsRoot, slug, "index.mdx"), "utf8");
    assert.doesNotMatch(page, /<th>난이도<\/th>/);
  }
});

test("content layout uses the full width beside the sidebar", () => {
  const styles = readFileSync(path.join(root, "src/styles/custom.css"), "utf8");

  assert.match(styles, /--sl-content-width:\s*min\(100%,\s*calc\(100vw - var\(--sl-sidebar-width\)/);
  assert.match(styles, /\.content-panel/);
  assert.match(styles, /--sl-content-margin-inline:\s*0/);
});
