import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const domains = ["접근 제어", "네트워크 보안", "데이터 보호", "Pod 보안"];
const domainOrder = new Map(domains.map((domain, index) => [domain, index]));
const phases = [
  {
    directoryNames: ["QuickWins"],
    phase: "Quick Wins",
    slug: "quick-wins",
    title: "Quick Wins",
    description: "짧은 시간 안에 EKS 보안 위험을 줄이는 초기 통제",
    introduction:
      "Quick Wins는 실습 환경이나 초기 운영 환경에서 빠르게 적용해 위험을 줄일 수 있는 항목입니다. 기본 ServiceAccount 사용 제한, TLS 강제, 이미지 취약점 스캔, 리소스 제한처럼 명확한 보안 효과를 빠르게 확인할 수 있는 통제를 우선 배치합니다.",
  },
  {
    directoryNames: ["Foundational", "foundational"],
    phase: "Foundational",
    slug: "foundational",
    title: "Foundational",
    description: "EKS 보안 운영의 기반이 되는 클러스터와 네트워크 통제",
    introduction:
      "Foundational 단계는 이후 보안 통제가 안정적으로 동작하기 위한 기반을 다룹니다. 클러스터 API endpoint, 노드와 Pod의 네트워크 위치, NetworkPolicy 집행처럼 설계 초기에 방향을 잡아야 하는 항목이 중심입니다.",
  },
  {
    directoryNames: ["Efficient"],
    phase: "Efficient",
    slug: "efficient",
    title: "Efficient",
    description: "자동화와 파이프라인 통합으로 EKS 보안 운영 효율을 높이는 단계",
    introduction:
      "Efficient 단계는 반복 점검과 수동 운영을 줄이고, 감사 추적, 보안 알림, 정책 자동화, 증적 수집을 운영 흐름에 통합하는 항목을 다룹니다.",
  },
  {
    directoryNames: ["Optimized"],
    phase: "Optimized",
    slug: "optimized",
    title: "Optimized",
    description: "조직 단위의 지속 개선과 고도화된 EKS 보안 운영 단계",
    introduction:
      "Optimized 단계는 런타임 위협 탐지, 서비스 간 mTLS, 고도화된 정책 관리, 자동 감사처럼 보안 운영을 지속적으로 개선하는 항목을 다룹니다.",
  },
];
const phaseByDirectory = new Map(
  phases.flatMap((phase) => phase.directoryNames.map((directoryName) => [directoryName, phase])),
);
const phaseOrder = new Map(phases.map((phase, index) => [phase.phase, index]));

const slugOverrides = new Map([
  ["접근 제어/QuickWins/Default SA 제한 및 토큰 비활성화.md", "default-service-account"],
  ["접근 제어/QuickWins/container root 권한 실행 제한.md", "non-root-containers"],
  ["네트워크 보안/QuickWins/Ingress와 Load Balancer에 TLS 강제.md", "ingress-load-balancer-tls"],
  ["네트워크 보안/Foundational/Kubernetes API endpoint를 private-only 전환.md", "private-api-endpoint"],
  ["네트워크 보안/Foundational/Worker node, Pod를 private subnet 배치.md", "private-subnets"],
  ["네트워크 보안/Foundational/기본 deny NetworkPolicy 적용.md", "default-deny-networkpolicy"],
  ["Pod 보안/QuickWins/Container Image 스캔 및 차단.md", "container-image-scanning"],
  ["Pod 보안/QuickWins/Cluster Resource 사용 제한.md", "resource-quota-limitrange"],
]);

const escapeYaml = (value) => JSON.stringify(value);

function listMarkdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(current);
    return entry.isFile() && entry.name.endsWith(".md") ? [current] : [];
  });
}

function transformLinks(markdown) {
  return markdown.replace(
    /\[([^\]]+)\]\(\/Users\/esc\/Desktop\/K8RVIS\/eks-secure-infra\/([^)#:]+)(?::(\d+))?\)/g,
    (_match, label, repoPath, line) => {
      const suffix = line ? `#L${line}` : "";
      return `[${label}](https://github.com/K8RVIS/eks-secure-infra/blob/main/${repoPath}${suffix})`;
    },
  );
}

function bodyWithoutLegacyHeader(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.startsWith("# ")) lines.shift();

  while (lines[0]?.trim() === "") lines.shift();
  while (lines[0]?.startsWith(">")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  if (lines[0]?.trim() === "---") lines.shift();
  while (lines[0]?.trim() === "") lines.shift();

  return transformLinks(lines.join("\n").trimStart());
}

function titleFrom(markdown) {
  const firstLine = markdown.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/^#\s+/, "").trim();
}

function descriptionFrom(body) {
  const paragraph = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(
      (part) =>
        part &&
        !part.startsWith("#") &&
        !part.startsWith("```") &&
        !part.startsWith("|") &&
        !part.startsWith("- ["),
    );
  return (paragraph ?? "EKS 보안 성숙도 항목").replace(/\s+/g, " ").slice(0, 150);
}

function difficultyFrom(markdown) {
  const match = markdown.match(/난이도:\*\*\s*([★☆]{3}|미정)|난이도:\s*([★☆]{3}|미정)/);
  return match?.[1] ?? match?.[2] ?? "미정";
}

function ownerFrom(markdown) {
  const match = markdown.match(/담당:\*\*\s*([^\n>]+)|담당:\s*([^\n>]+)/);
  return (match?.[1] ?? match?.[2] ?? "공통 (전체 실습)").trim();
}

function slugify(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(baseSlug, usedSlugs) {
  let slug = baseSlug || "item";
  let index = 2;
  while (usedSlugs.has(slug)) {
    slug = `${baseSlug}-${index}`;
    index += 1;
  }
  usedSlugs.add(slug);
  return slug;
}

function sourceItems() {
  const usedSlugsByPhase = new Map(phases.map((phase) => [phase.slug, new Set()]));
  const files = domains
    .flatMap((domain) =>
      listMarkdownFiles(path.join(root, domain)).map((file) => {
        const relative = path.relative(root, file);
        const [, phaseDirectory] = relative.split(path.sep);
        const phase = phaseByDirectory.get(phaseDirectory);
        return phase ? { domain, file, phase, relative } : null;
      }),
    )
    .filter(Boolean)
    .sort((a, b) => {
      const phaseDiff = phaseOrder.get(a.phase.phase) - phaseOrder.get(b.phase.phase);
      if (phaseDiff !== 0) return phaseDiff;
      const domainDiff = domainOrder.get(a.domain) - domainOrder.get(b.domain);
      if (domainDiff !== 0) return domainDiff;
      return a.relative.localeCompare(b.relative, "ko");
    });

  const phaseCounters = new Map(phases.map((phase) => [phase.phase, 0]));

  return files.map((item) => {
    const markdown = readFileSync(item.file, "utf8");
    const order = phaseCounters.get(item.phase.phase) + 10;
    phaseCounters.set(item.phase.phase, order);
    const baseSlug = slugOverrides.get(item.relative) ?? slugify(path.basename(item.file));
    const slug = uniqueSlug(baseSlug, usedSlugsByPhase.get(item.phase.slug));

    return {
      ...item,
      title: titleFrom(markdown),
      body: bodyWithoutLegacyHeader(markdown),
      description: descriptionFrom(bodyWithoutLegacyHeader(markdown)),
      difficulty: difficultyFrom(markdown),
      owner: ownerFrom(markdown),
      order,
      slug,
      href: `/${item.phase.slug}/${slug}`,
    };
  });
}

function writePhaseIndex(docsDir, phase) {
  const targetPath = path.join(docsDir, phase.slug, "index.mdx");
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    [
      "---",
      `title: ${escapeYaml(phase.title)}`,
      `description: ${escapeYaml(phase.description)}`,
      `phase: ${escapeYaml(phase.phase)}`,
      "sidebar:",
      "  order: 1",
      "---",
      "",
      'import MaturityMatrix from "../../../components/MaturityMatrix.astro";',
      "",
      `# ${phase.title}`,
      "",
      phase.introduction,
      "",
      "각 항목은 적용 전 상태를 확인하고, 매니페스트 또는 클러스터 설정을 변경한 뒤, 명령으로 기대 결과를 검증하는 흐름으로 읽으면 됩니다.",
      "",
      `<MaturityMatrix initialPhase="${phase.phase}" layout="phase-domain" />`,
      "",
    ].join("\n"),
  );
}

const docsDir = path.join(root, "src/content/docs");
const dataDir = path.join(root, "src/data");
mkdirSync(docsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

for (const phase of phases) {
  rmSync(path.join(docsDir, phase.slug), { recursive: true, force: true });
}
rmSync(path.join(docsDir, "efficient.md"), { force: true });
rmSync(path.join(docsDir, "optimized.md"), { force: true });

for (const phase of phases) {
  writePhaseIndex(docsDir, phase);
}

const items = sourceItems();

for (const item of items) {
  const targetPath = path.join(docsDir, item.phase.slug, `${item.slug}.md`);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    [
      "---",
      `title: ${escapeYaml(item.title)}`,
      `description: ${escapeYaml(item.description)}`,
      `phase: ${escapeYaml(item.phase.phase)}`,
      `domain: ${escapeYaml(item.domain)}`,
      `difficulty: ${escapeYaml(item.difficulty)}`,
      `owner: ${escapeYaml(item.owner)}`,
      `order: ${item.order}`,
      "sidebar:",
      `  order: ${item.order}`,
      "---",
      "",
      item.body,
      "",
    ].join("\n"),
  );
}

writeFileSync(
  path.join(dataDir, "maturity-items.json"),
  `${JSON.stringify(
    items.map((item) => ({
      title: item.title,
      phase: item.phase.phase,
      domain: item.domain,
      difficulty: item.difficulty,
      href: item.href,
      order: item.order,
    })),
    null,
    2,
  )}\n`,
);
