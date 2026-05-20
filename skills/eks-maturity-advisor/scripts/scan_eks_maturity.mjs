#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const SECRET_NAME_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;

function listYamlFiles(dir) {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") return [];
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return listYamlFiles(current);
    return /\.(ya?ml)$/.test(entry.name) ? [current] : [];
  });
}

function loadDocuments(repoRoot) {
  return listYamlFiles(repoRoot).flatMap((file) => {
    const relative = path.relative(repoRoot, file);
    try {
      return yaml.loadAll(readFileSync(file, "utf8"))
        .filter((doc) => doc && typeof doc === "object")
        .map((doc) => ({ file: relative, doc }));
    } catch (error) {
      return [{ file: relative, doc: { kind: "__ParseError", message: error.message } }];
    }
  });
}

function namespaceOf(doc) {
  return doc?.metadata?.namespace || "default";
}

function podSpecFor(doc) {
  if (!WORKLOAD_KINDS.has(doc.kind)) return null;
  if (doc.kind === "Pod") return doc.spec ?? null;
  if (doc.kind === "CronJob") return doc.spec?.jobTemplate?.spec?.template?.spec ?? null;
  return doc.spec?.template?.spec ?? null;
}

function containersFor(podSpec) {
  return [...(podSpec?.containers ?? []), ...(podSpec?.initContainers ?? [])];
}

function finding(item_id, status, severity, evidence, recommendation, verify_commands = []) {
  return {
    item_id,
    phase: "Quick Wins",
    status,
    severity,
    evidence,
    recommendation,
    verify_commands,
    source_reference: `references/catalog.json#${item_id}`,
  };
}

function checkNonRoot(entries) {
  const workloads = entries
    .map(({ file, doc }) => ({ file, doc, podSpec: podSpecFor(doc) }))
    .filter((entry) => entry.podSpec);

  if (workloads.length === 0) {
    return finding(
      "quick-wins/non-root-containers",
      "unknown",
      "medium",
      ["No Kubernetes workload manifests were found."],
      "Deployment, StatefulSet, DaemonSet, Job, CronJob, or Pod manifests are required for static non-root assessment.",
    );
  }

  const failures = [];
  for (const { file, doc, podSpec } of workloads) {
    const podContext = podSpec.securityContext ?? {};
    for (const container of containersFor(podSpec)) {
      const context = container.securityContext ?? {};
      const runAsUser = context.runAsUser ?? podContext.runAsUser;
      const runAsNonRoot = context.runAsNonRoot ?? podContext.runAsNonRoot;

      if (runAsUser === 0 || runAsNonRoot !== true) {
        failures.push(`${file}: ${doc.kind}/${doc.metadata?.name ?? "<unnamed>"} container ${container.name ?? "<unnamed>"} lacks runAsNonRoot=true or uses UID 0`);
      }
    }
  }

  return finding(
    "quick-wins/non-root-containers",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : [`${workloads.length} workload manifest(s) declare non-root execution.`],
    "Set pod/container securityContext.runAsNonRoot=true, use a non-zero runAsUser, and add container-level hardening such as readOnlyRootFilesystem where possible.",
    ["kubectl get deploy,statefulset,daemonset -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\t\"}{.spec.template.spec.securityContext}{\"\\n\"}{end}'"],
  );
}

function checkServiceAccounts(entries) {
  const workloads = entries
    .map(({ file, doc }) => ({ file, doc, podSpec: podSpecFor(doc) }))
    .filter((entry) => entry.podSpec);

  if (workloads.length === 0) {
    return finding("quick-wins/default-service-account", "unknown", "medium", ["No Kubernetes workload manifests were found."], "Add workload manifests before assessing ServiceAccount usage.");
  }

  const failures = [];
  for (const { file, doc, podSpec } of workloads) {
    const serviceAccountName = podSpec.serviceAccountName ?? "default";
    const automount = podSpec.automountServiceAccountToken;
    if (serviceAccountName === "default" || automount !== false) {
      failures.push(`${file}: ${doc.kind}/${doc.metadata?.name ?? "<unnamed>"} uses ${serviceAccountName} with automountServiceAccountToken=${String(automount)}`);
    }
  }

  return finding(
    "quick-wins/default-service-account",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : [`${workloads.length} workload manifest(s) avoid default ServiceAccount token mounting.`],
    "Use workload-specific ServiceAccounts and set automountServiceAccountToken=false unless the workload needs Kubernetes API access.",
    ["kubectl get deploy,statefulset,daemonset -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\t\"}{.spec.template.spec.serviceAccountName}{\"\\t\"}{.spec.template.spec.automountServiceAccountToken}{\"\\n\"}{end}'"],
  );
}

function ingressHasTls(doc) {
  const annotations = doc.metadata?.annotations ?? {};
  const listenPorts = annotations["alb.ingress.kubernetes.io/listen-ports"] ?? "";
  const hasAlbTls = Boolean(annotations["alb.ingress.kubernetes.io/certificate-arn"]) && /HTTPS/.test(listenPorts);
  return (doc.spec?.tls ?? []).length > 0 || hasAlbTls;
}

function checkIngressTls(entries) {
  const ingresses = entries.filter(({ doc }) => doc.kind === "Ingress");
  if (ingresses.length === 0) {
    return finding("quick-wins/ingress-load-balancer-tls", "unknown", "medium", ["No Ingress manifests were found."], "Assess TLS once Ingress or Load Balancer manifests exist.");
  }

  const failures = ingresses
    .filter(({ doc }) => !ingressHasTls(doc))
    .map(({ file, doc }) => `${file}: Ingress/${doc.metadata?.name ?? "<unnamed>"} lacks spec.tls or ALB HTTPS certificate annotations`);

  return finding(
    "quick-wins/ingress-load-balancer-tls",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : [`${ingresses.length} Ingress manifest(s) declare TLS termination.`],
    "Declare spec.tls for Kubernetes Ingress or configure AWS Load Balancer Controller HTTPS listener, ACM certificate ARN, and SSL redirect annotations.",
    ["kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\t\"}{.spec.tls}{\"\\t\"}{.metadata.annotations}{\"\\n\"}{end}'"],
  );
}

function checkQuotaAndLimits(entries) {
  const workloadNamespaces = new Set(
    entries
      .filter(({ doc }) => podSpecFor(doc))
      .map(({ doc }) => namespaceOf(doc)),
  );
  const quotaNamespaces = new Set(entries.filter(({ doc }) => doc.kind === "ResourceQuota").map(({ doc }) => namespaceOf(doc)));
  const limitNamespaces = new Set(entries.filter(({ doc }) => doc.kind === "LimitRange").map(({ doc }) => namespaceOf(doc)));

  if (workloadNamespaces.size === 0) {
    return finding("quick-wins/resource-quota-limitrange", "unknown", "medium", ["No workload namespaces were found."], "Add workload manifests before assessing namespace quota and default limits.");
  }

  const failures = [...workloadNamespaces].flatMap((namespace) => {
    const missing = [];
    if (!quotaNamespaces.has(namespace)) missing.push("ResourceQuota");
    if (!limitNamespaces.has(namespace)) missing.push("LimitRange");
    return missing.length > 0 ? [`namespace ${namespace} is missing ${missing.join(" and ")}`] : [];
  });

  return finding(
    "quick-wins/resource-quota-limitrange",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "medium" : "low",
    failures.length > 0 ? failures : [`${workloadNamespaces.size} namespace(s) include ResourceQuota and LimitRange.`],
    "Define ResourceQuota and LimitRange for every application namespace so workloads have bounded requests and limits.",
    ["kubectl get resourcequota,limitrange -A"],
  );
}

function hasHardcodedSecret(obj) {
  if (Array.isArray(obj)) return obj.some(hasHardcodedSecret);
  if (!obj || typeof obj !== "object") return false;

  if (typeof obj.name === "string" && Object.hasOwn(obj, "value") && typeof obj.value === "string") {
    return SECRET_NAME_PATTERN.test(obj.name) && obj.value.length > 0;
  }

  return Object.values(obj).some(hasHardcodedSecret);
}

function checkHardcodedSecrets(entries) {
  const failures = entries
    .filter(({ doc }) => hasHardcodedSecret(doc))
    .map(({ file, doc }) => `${file}: ${doc.kind ?? "Document"}/${doc.metadata?.name ?? "<unnamed>"} contains an env-style secret value`);

  return finding(
    "quick-wins/aws-secret-manager-사용",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : ["No env[].value entries with secret-like names were found."],
    "Move literal secret values to AWS Secrets Manager or another external secret store, then reference them through ESO, CSI, or application runtime lookup.",
    ["kubectl get deploy,statefulset,daemonset -A -o yaml | grep -Ei 'password|secret|token|api[_-]?key'"],
  );
}

export function scanRepository({ repoRoot = process.cwd() } = {}) {
  const absoluteRoot = path.resolve(repoRoot);
  const entries = loadDocuments(absoluteRoot);
  const findings = [
    checkNonRoot(entries),
    checkServiceAccounts(entries),
    checkIngressTls(entries),
    checkQuotaAndLimits(entries),
    checkHardcodedSecrets(entries),
  ];

  return {
    scanner: "eks-maturity-advisor",
    mode: "repo-only",
    repo_root: absoluteRoot,
    findings,
  };
}

export function renderMarkdown(report) {
  const lines = ["# EKS Maturity Advisor Report", "", `Mode: ${report.mode}`, ""];
  for (const finding of report.findings) {
    lines.push(`## ${finding.item_id}`, "", `Status: ${finding.status}`, `Severity: ${finding.severity}`, "", "Evidence:");
    for (const item of finding.evidence) lines.push(`- ${item}`);
    lines.push("", `Recommendation: ${finding.recommendation}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), output: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") args.repoRoot = argv[++index];
    if (arg === "--output") args.output = argv[++index];
    if (arg === "--live") {
      throw new Error("Live cluster scanning is planned for v1.1. v1 only supports repo-only scanning.");
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const report = scanRepository({ repoRoot: args.repoRoot });
  process.stdout.write(args.output === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
}
