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

test("skill release workflow packages the advisor on version tags", () => {
  const workflowPath = path.join(root, ".github/workflows/release-skill.yml");

  assert.match(readFileSync(workflowPath, "utf8"), /eks-maturity-advisor-v\*/);
});
