import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);

function writeFixture(filePath, content) {
  const lines = content.replace(/^\n/, "").split("\n");
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length),
  );
  writeFileSync(filePath, `${lines.map((line) => line.slice(indentation)).join("\n").trimEnd()}\n`, "utf8");
}

function statusByItem(findings) {
  return new Map(findings.map((finding) => [finding.item_id, finding.status]));
}

function findingByItem(findings, itemId) {
  return findings.find((finding) => finding.item_id === itemId);
}

function successfulLiveCommandRunner(calls = []) {
  return ({ command, args }) => {
    calls.push([command, ...args].join(" "));
    const commandLine = [command, ...args].join(" ");

    if (commandLine === "kubectl config current-context") {
      return "arn:aws:eks:ap-northeast-2:357542025037:cluster/eks-secure-infra-dev\n";
    }

    if (commandLine === "kubectl config view --minify -o json") {
      return JSON.stringify({
        users: [
          {
            user: {
              exec: {
                args: ["--region", "ap-northeast-2", "eks", "get-token", "--cluster-name", "eks-secure-infra-dev", "--output", "json"],
                env: [{ name: "AWS_PROFILE", value: "eks-security-infra" }],
              },
            },
          },
        ],
      });
    }

    if (commandLine.includes("aws eks describe-cluster")) {
      return JSON.stringify({
        cluster: {
          resourcesVpcConfig: {
            endpointPublicAccess: false,
            endpointPrivateAccess: true,
          },
          accessConfig: {
            authenticationMode: "API_AND_CONFIG_MAP",
          },
        },
      });
    }

    if (commandLine.includes("aws eks list-nodegroups")) {
      return JSON.stringify({ nodegroups: ["system"] });
    }

    if (commandLine.includes("aws eks describe-nodegroup")) {
      return JSON.stringify({ nodegroup: { subnets: ["subnet-private-a", "subnet-private-b"] } });
    }

    if (commandLine.includes("aws ec2 describe-subnets")) {
      return JSON.stringify({
        Subnets: [
          { SubnetId: "subnet-private-a", MapPublicIpOnLaunch: false },
          { SubnetId: "subnet-private-b", MapPublicIpOnLaunch: false },
        ],
      });
    }

    if (commandLine.includes("aws eks list-access-entries")) {
      return JSON.stringify({ accessEntries: ["arn:aws:iam::123456789012:role/platform-admin"] });
    }

    if (commandLine.includes("aws inspector2 list-filters")) {
      return JSON.stringify({ filters: [{ name: "eks-secure-infra-triage-web", arn: "arn:aws:inspector2:ap-northeast-2:123456789012:filter/triage-web" }] });
    }

    if (commandLine.includes("aws inspector2 list-findings")) {
      return JSON.stringify({ findings: [] });
    }

    if (commandLine.includes("aws ec2 get-ebs-encryption-by-default")) {
      return JSON.stringify({ EbsEncryptionByDefault: true });
    }

    if (commandLine.includes("aws ec2 describe-volumes")) {
      return JSON.stringify({ Volumes: [{ VolumeId: "vol-123", Encrypted: true }] });
    }

    if (commandLine.includes("kubectl get pods -n monitoring")) {
      return JSON.stringify({
        items: [{ metadata: { namespace: "monitoring", name: "grafana-0" }, status: { phase: "Running" } }],
      });
    }

    if (commandLine.includes("kubectl get pvc -n monitoring")) {
      return JSON.stringify({
        items: [{ metadata: { namespace: "monitoring", name: "grafana" }, spec: { storageClassName: "encrypted-gp3" }, status: { phase: "Bound" } }],
      });
    }

    if (commandLine.includes("kubectl get ingress -n monitoring")) {
      return JSON.stringify({ items: [{ metadata: { namespace: "monitoring", name: "grafana" } }] });
    }

    if (commandLine.includes("kubectl get storageclass")) {
      return JSON.stringify({
        items: [
          {
            metadata: { name: "encrypted-gp3", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
            provisioner: "ebs.csi.aws.com",
            parameters: { encrypted: "true", type: "gp3" },
          },
        ],
      });
    }

    if (commandLine.includes("kubectl get pvc -A")) {
      return JSON.stringify({
        items: [{ metadata: { namespace: "team-a", name: "db" }, spec: { storageClassName: "encrypted-gp3", volumeName: "pv-db" }, status: { phase: "Bound" } }],
      });
    }

    if (commandLine.includes("kubectl get pv")) {
      return JSON.stringify({
        items: [{ metadata: { name: "pv-db" }, spec: { csi: { driver: "ebs.csi.aws.com", volumeHandle: "vol-123" } } }],
      });
    }

    if (commandLine.includes("kubectl get externalsecrets")) {
      return JSON.stringify({ items: [{ metadata: { namespace: "team-a", name: "app-runtime-secrets" } }] });
    }

    if (commandLine.includes("kubectl get deployments,statefulsets,daemonsets,jobs,cronjobs")) {
      return JSON.stringify({
        items: [
          {
            kind: "Deployment",
            metadata: { namespace: "team-a", name: "api" },
            spec: { template: { spec: { containers: [{ name: "api", env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "app-runtime-secrets", key: "password" } } }] }] } } },
          },
        ],
      });
    }

    if (commandLine.includes("kubectl get roles,rolebindings")) {
      return JSON.stringify({
        items: [
          { kind: "Role", metadata: { namespace: "team-a", name: "reader" }, rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] }] },
          { kind: "RoleBinding", metadata: { namespace: "team-a", name: "reader-binding" }, subjects: [{ kind: "ServiceAccount", name: "api", namespace: "team-a" }] },
        ],
      });
    }

    if (commandLine.includes("kubectl get clusterroles,clusterrolebindings")) {
      return JSON.stringify({ items: [] });
    }

    if (commandLine.includes("kubectl get pods")) {
      return JSON.stringify({
        items: [
          {
            metadata: { namespace: "team-a", name: "api" },
            spec: {
              containers: [{ name: "api", securityContext: { privileged: false } }],
            },
          },
        ],
      });
    }

    if (commandLine.includes("kubectl get networkpolicy")) {
      return JSON.stringify({
        items: [
          {
            metadata: { namespace: "team-a", name: "default-deny" },
            spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
          },
        ],
      });
    }

    if (commandLine.includes("kubectl get namespaces")) {
      return JSON.stringify({
        items: [
          {
            metadata: {
              name: "team-a",
              labels: { "pod-security.kubernetes.io/enforce": "baseline" },
            },
          },
        ],
      });
    }

    throw new Error(`unexpected command: ${commandLine}`);
  };
}

test("generated skill catalog covers Quick Wins and Foundational docs from source content", async () => {
  const { buildCatalog } = await import("../skills/eks-maturity-advisor/scripts/generate_catalog.mjs");

  const catalog = buildCatalog({ root });
  const phases = new Set(catalog.items.map((item) => item.phase));
  const nonRoot = catalog.items.find((item) => item.item_id === "quick-wins/non-root-containers");

  assert.deepEqual(phases, new Set(["Quick Wins", "Foundational"]));
  assert.ok(catalog.items.length >= 16);
  assert.equal(nonRoot.title, "컨테이너를 non-root 사용자로 실행하고 루트 파일시스템 쓰기를 제한한다");
  assert.equal(nonRoot.domain, "접근 제어");
  assert.ok(nonRoot.checks.length > 0);
  assert.ok(nonRoot.verify_commands.some((command) => command.includes("kubectl")));
  assert.equal(nonRoot.source_reference, "src/content/docs/quick-wins/non-root-containers.md");
});

test("repo scanner reports Quick Wins failures for insecure manifests", async () => {
  const { scanRepository } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const repoRoot = mkdtempSync(path.join(tmpdir(), "eks-maturity-insecure-"));

  writeFixture(
    path.join(repoRoot, "app.yaml"),
    `
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      namespace: team-a
    spec:
      template:
        spec:
          serviceAccountName: default
          automountServiceAccountToken: true
          containers:
            - name: api
              image: example/api:latest
              env:
                - name: DB_PASSWORD
                  value: plaintext-password
              securityContext:
                runAsUser: 0
    ---
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: web
      namespace: team-a
    spec:
      rules:
        - host: web.example.com
    `,
  );

  const statuses = statusByItem(scanRepository({ repoRoot }).findings);

  assert.equal(statuses.get("quick-wins/non-root-containers"), "fail");
  assert.equal(statuses.get("quick-wins/default-service-account"), "fail");
  assert.equal(statuses.get("quick-wins/ingress-load-balancer-tls"), "fail");
  assert.equal(statuses.get("quick-wins/resource-quota-limitrange"), "fail");
  assert.equal(statuses.get("quick-wins/aws-secret-manager-사용"), "fail");
});

test("repo scanner reports Quick Wins passes for hardened manifests", async () => {
  const { scanRepository } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const repoRoot = mkdtempSync(path.join(tmpdir(), "eks-maturity-hardened-"));

  writeFixture(
    path.join(repoRoot, "app.yaml"),
    `
    apiVersion: v1
    kind: Namespace
    metadata:
      name: team-a
    ---
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      namespace: team-a
    spec:
      template:
        spec:
          serviceAccountName: api-workload
          automountServiceAccountToken: false
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
          containers:
            - name: api
              image: example/api:latest
              securityContext:
                runAsNonRoot: true
                runAsUser: 10001
                readOnlyRootFilesystem: true
    ---
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: web
      namespace: team-a
    spec:
      tls:
        - hosts:
            - web.example.com
          secretName: web-tls
      rules:
        - host: web.example.com
    ---
    apiVersion: v1
    kind: ResourceQuota
    metadata:
      name: team-quota
      namespace: team-a
    spec:
      hard:
        requests.cpu: "2"
    ---
    apiVersion: v1
    kind: LimitRange
    metadata:
      name: default-limits
      namespace: team-a
    spec:
      limits:
        - type: Container
          defaultRequest:
            cpu: 100m
    `,
  );

  const statuses = statusByItem(scanRepository({ repoRoot }).findings);

  assert.equal(statuses.get("quick-wins/non-root-containers"), "pass");
  assert.equal(statuses.get("quick-wins/default-service-account"), "pass");
  assert.equal(statuses.get("quick-wins/ingress-load-balancer-tls"), "pass");
  assert.equal(statuses.get("quick-wins/resource-quota-limitrange"), "pass");
  assert.equal(statuses.get("quick-wins/aws-secret-manager-사용"), "pass");
});

test("repo scanner includes domain and priority metadata for sorted findings", async () => {
  const { scanRepository } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const repoRoot = mkdtempSync(path.join(tmpdir(), "eks-maturity-priority-"));

  writeFixture(
    path.join(repoRoot, "app.yaml"),
    `
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      namespace: team-a
    spec:
      template:
        spec:
          serviceAccountName: default
          automountServiceAccountToken: true
          containers:
            - name: api
              image: example/api:latest
              securityContext:
                runAsUser: 0
    `,
  );

  const report = scanRepository({ repoRoot });
  const nonRoot = findingByItem(report.findings, "quick-wins/non-root-containers");
  const quota = findingByItem(report.findings, "quick-wins/resource-quota-limitrange");

  assert.equal(nonRoot.domain, "접근 제어");
  assert.equal(nonRoot.priority, "P1");
  assert.equal(quota.priority, "P2");
  assert.deepEqual(
    report.findings.map((finding) => finding.priority),
    ["P1", "P1", "P2", "P3", "P3"],
  );
});

test("live scanner reports approved v1.1 Foundational controls from read-only command output", async () => {
  const { scanLiveCluster } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const calls = [];

  const report = scanLiveCluster({
    clusterName: "prod",
    context: "prod-context",
    region: "ap-northeast-2",
    commandRunner: successfulLiveCommandRunner(calls),
  });
  const statuses = statusByItem(report.findings);

  assert.equal(report.mode, "live-cluster");
  assert.equal(report.findings.length, 10);
  assert.equal(statuses.get("foundational/private-api-endpoint"), "pass");
  assert.equal(statuses.get("foundational/private-subnets"), "pass");
  assert.equal(statuses.get("foundational/default-deny-networkpolicy"), "pass");
  assert.equal(statuses.get("foundational/pod-실행-권한-최소화"), "pass");
  assert.equal(statuses.get("foundational/iam-k8s-mapping"), "pass");
  assert.ok(report.findings.every((finding) => finding.phase === "Foundational"));
  assert.ok(report.findings.every((finding) => finding.priority));
  assert.ok(calls.every((call) => /^(aws (eks|ec2|inspector2) (describe|list|get)|kubectl get)/.test(call)));
});

test("live scanner reports remaining Foundational controls from read-only command output", async () => {
  const { scanLiveCluster } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const report = scanLiveCluster({
    clusterName: "prod",
    context: "prod-context",
    region: "ap-northeast-2",
    commandRunner: successfulLiveCommandRunner(),
  });
  const statuses = statusByItem(report.findings);

  assert.equal(statuses.get("foundational/container-image-취약점-관리"), "pass");
  assert.equal(statuses.get("foundational/grafana-대시보드-연결"), "pass");
  assert.equal(statuses.get("foundational/ebs-기반-workload-storage-data-보호"), "pass");
  assert.equal(statuses.get("foundational/workload-내-hardcoded-secret-제거"), "pass");
  assert.equal(statuses.get("foundational/cluster내-리소스-접근제어"), "pass");
});

test("live scanner can auto-detect EKS live scan inputs from the current kubeconfig", async () => {
  const { scanLiveCluster } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const calls = [];

  const report = scanLiveCluster({
    autoDetect: true,
    commandRunner: successfulLiveCommandRunner(calls),
  });

  assert.equal(report.cluster_name, "eks-secure-infra-dev");
  assert.equal(report.kubectl_context, "arn:aws:eks:ap-northeast-2:357542025037:cluster/eks-secure-infra-dev");
  assert.equal(report.region, "ap-northeast-2");
  assert.equal(report.aws_profile, "eks-security-infra");
  assert.ok(calls.some((call) => call === "kubectl config current-context"));
  assert.ok(calls.some((call) => call === "kubectl config view --minify -o json"));
  assert.ok(calls.some((call) => call.includes("--profile eks-security-infra")));
});

test("live scanner returns unknown findings when read-only commands cannot run", async () => {
  const { scanLiveCluster } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");

  const report = scanLiveCluster({
    clusterName: "prod",
    context: "prod-context",
    region: "ap-northeast-2",
    commandRunner: ({ command }) => {
      throw new Error(`${command} is not available`);
    },
  });

  assert.equal(report.mode, "live-cluster");
  assert.equal(report.findings.length, 10);
  assert.ok(report.findings.every((finding) => finding.status === "unknown"));
  assert.ok(report.findings.every((finding) => finding.priority === "P3"));
  assert.ok(report.findings.every((finding) => finding.verify_commands.length > 0));
});

test("live scanner does not query the current kubectl context when live flags are missing", async () => {
  const { scanLiveCluster } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const calls = [];

  const report = scanLiveCluster({
    commandRunner: ({ command, args }) => {
      calls.push([command, ...args].join(" "));
      throw new Error("command should not run without explicit live scan inputs");
    },
  });

  assert.equal(report.findings.length, 10);
  assert.ok(report.findings.every((finding) => finding.status === "unknown"));
  assert.deepEqual(calls, []);
});

test("scanner renders Korean evidence and recommendation text", async () => {
  const { renderMarkdown, scanLiveCluster, scanRepository } = await import("../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs");
  const repoRoot = mkdtempSync(path.join(tmpdir(), "eks-maturity-korean-"));

  writeFixture(
    path.join(repoRoot, "app.yaml"),
    `
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      namespace: team-a
    spec:
      template:
        spec:
          serviceAccountName: default
          containers:
            - name: api
              image: example/api:latest
              securityContext:
                runAsUser: 0
    `,
  );

  const repoFinding = findingByItem(scanRepository({ repoRoot }).findings, "quick-wins/non-root-containers");
  const liveFinding = findingByItem(scanLiveCluster().findings, "foundational/private-api-endpoint");
  const markdown = renderMarkdown({ mode: "test", findings: [repoFinding] });

  assert.match(repoFinding.evidence[0], /컨테이너|루트|실행/);
  assert.match(repoFinding.recommendation, /설정|사용|강화/);
  assert.match(liveFinding.evidence[0], /입력값이 부족합니다/);
  assert.match(liveFinding.recommendation, /입력값을 제공/);
  assert.match(markdown, /증거:/);
  assert.match(markdown, /권장 조치:/);
  assert.doesNotMatch(markdown, /Evidence:|Recommendation:/);
});

test("skill release workflow packages the advisor on version tags", () => {
  const workflowPath = path.join(root, ".github/workflows/release-skill.yml");

  assert.match(readFileSync(workflowPath, "utf8"), /eks-maturity-advisor-v\*/);
});
