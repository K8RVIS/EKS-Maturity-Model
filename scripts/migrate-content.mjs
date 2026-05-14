import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sources = [
  {
    source: "접근 제어/QuickWins/Default SA 제한 및 토큰 비활성화.md",
    slug: "quick-wins/default-service-account",
    phase: "Quick Wins",
    domain: "접근 제어",
    difficulty: "★☆☆",
    order: 10,
  },
  {
    source: "접근 제어/QuickWins/container root 권한 실행 제한.md",
    slug: "quick-wins/non-root-containers",
    phase: "Quick Wins",
    domain: "컨테이너 보안",
    difficulty: "★☆☆",
    order: 20,
  },
  {
    source: "네트워크 보안/QuickWins/Public API endpoint 접근 CIDR 제한.md",
    slug: "quick-wins/public-api-cidr",
    phase: "Quick Wins",
    domain: "네트워크 보안",
    difficulty: "★☆☆",
    order: 30,
  },
  {
    source: "네트워크 보안/QuickWins/Ingress와 Load Balancer에 TLS 강제.md",
    slug: "quick-wins/ingress-load-balancer-tls",
    phase: "Quick Wins",
    domain: "네트워크 보안",
    difficulty: "★☆☆",
    order: 40,
  },
  {
    source: "데이터 보호/QuickWins/외부 진입점 TLS 인증서 자동 관리.md",
    slug: "quick-wins/tls-certificate-automation",
    phase: "Quick Wins",
    domain: "데이터 보호",
    difficulty: "★☆☆",
    order: 50,
  },
  {
    source: "데이터 보호/QuickWins/Workload 내 Hardcoded Secret 제거.md",
    slug: "quick-wins/workload-hardcoded-secrets",
    phase: "Quick Wins",
    domain: "데이터 보호",
    difficulty: "★★☆",
    order: 60,
  },
  {
    source: "Pod 보안/QuickWins/Container Image 취약점 탐지.md",
    slug: "quick-wins/container-image-scanning",
    phase: "Quick Wins",
    domain: "Pod 보안",
    difficulty: "★☆☆",
    order: 70,
  },
  {
    source: "Pod 보안/QuickWins/Cluster Resource 사용 제한.md",
    slug: "quick-wins/resource-quota-limitrange",
    phase: "Quick Wins",
    domain: "Pod 보안",
    difficulty: "★☆☆",
    order: 80,
  },
  {
    source: "네트워크 보안/Foundational/Kubernetes API endpoint를 private-only 전환.md",
    slug: "foundational/private-api-endpoint",
    phase: "Foundational",
    domain: "네트워크 보안",
    difficulty: "★★☆",
    order: 10,
  },
  {
    source: "네트워크 보안/Foundational/Worker node, Pod를 private subnet 배치.md",
    slug: "foundational/private-subnets",
    phase: "Foundational",
    domain: "네트워크 보안",
    difficulty: "미정",
    order: 20,
  },
  {
    source: "네트워크 보안/Foundational/기본 deny NetworkPolicy 적용.md",
    slug: "foundational/default-deny-networkpolicy",
    phase: "Foundational",
    domain: "네트워크 보안",
    difficulty: "미정",
    order: 30,
  },
];

const escapeYaml = (value) => JSON.stringify(value);

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
    .map((part) => part.replace(/^#+\s+/, "").trim())
    .find((part) => part && !part.startsWith("```") && !part.startsWith("|"));
  return (paragraph ?? "EKS 보안 성숙도 항목").replace(/\s+/g, " ").slice(0, 150);
}

const docsDir = path.join(root, "src/content/docs");
const dataDir = path.join(root, "src/data");
mkdirSync(docsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const items = sources.map((item) => {
  const sourcePath = path.join(root, item.source);
  const markdown = readFileSync(sourcePath, "utf8");
  const title = titleFrom(markdown);
  const body = bodyWithoutLegacyHeader(markdown);
  const description = descriptionFrom(body);
  const targetPath = path.join(docsDir, `${item.slug}.md`);

  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    [
      "---",
      `title: ${escapeYaml(title)}`,
      `description: ${escapeYaml(description)}`,
      `phase: ${escapeYaml(item.phase)}`,
      `domain: ${escapeYaml(item.domain)}`,
      `difficulty: ${escapeYaml(item.difficulty)}`,
      'owner: "공통 (전체 실습)"',
      `order: ${item.order}`,
      "sidebar:",
      `  order: ${item.order}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );

  return {
    title,
    phase: item.phase,
    domain: item.domain,
    difficulty: item.difficulty,
    href: `/${item.slug}`,
    order: item.order,
  };
});

writeFileSync(path.join(dataDir, "maturity-items.json"), `${JSON.stringify(items, null, 2)}\n`);
