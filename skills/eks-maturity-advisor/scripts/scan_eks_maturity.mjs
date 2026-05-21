#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const SECRET_NAME_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);
const ITEM_METADATA = {
  "quick-wins/non-root-containers": { phase: "Quick Wins", domain: "접근 제어" },
  "quick-wins/default-service-account": { phase: "Quick Wins", domain: "접근 제어" },
  "quick-wins/ingress-load-balancer-tls": { phase: "Quick Wins", domain: "네트워크 보안" },
  "quick-wins/resource-quota-limitrange": { phase: "Quick Wins", domain: "Pod 보안" },
  "quick-wins/aws-secret-manager-사용": { phase: "Quick Wins", domain: "데이터 보호" },
  "foundational/private-api-endpoint": { phase: "Foundational", domain: "네트워크 보안" },
  "foundational/private-subnets": { phase: "Foundational", domain: "네트워크 보안" },
  "foundational/default-deny-networkpolicy": { phase: "Foundational", domain: "네트워크 보안" },
  "foundational/pod-실행-권한-최소화": { phase: "Foundational", domain: "Pod 보안" },
  "foundational/iam-k8s-mapping": { phase: "Foundational", domain: "접근 제어" },
  "foundational/container-image-취약점-관리": { phase: "Foundational", domain: "Pod 보안" },
  "foundational/grafana-대시보드-연결": { phase: "Foundational", domain: "Pod 보안" },
  "foundational/ebs-기반-workload-storage-data-보호": { phase: "Foundational", domain: "데이터 보호" },
  "foundational/workload-내-hardcoded-secret-제거": { phase: "Foundational", domain: "데이터 보호" },
  "foundational/cluster내-리소스-접근제어": { phase: "Foundational", domain: "접근 제어" },
};
const PRIORITY_ORDER = new Map([
  ["P1", 0],
  ["P2", 1],
  ["P3", 2],
]);
const STATUS_ORDER = new Map([
  ["fail", 0],
  ["warn", 1],
  ["unknown", 2],
  ["pass", 3],
]);

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

function priorityFor(status, severity) {
  if (status === "fail" && severity === "high") return "P1";
  if (status === "fail" && severity === "medium") return "P2";
  if (status === "warn" && (severity === "high" || severity === "medium")) return "P2";
  return "P3";
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const priority = (PRIORITY_ORDER.get(a.priority) ?? 99) - (PRIORITY_ORDER.get(b.priority) ?? 99);
    if (priority !== 0) return priority;

    const status = (STATUS_ORDER.get(a.status) ?? 99) - (STATUS_ORDER.get(b.status) ?? 99);
    if (status !== 0) return status;

    return a.item_id.localeCompare(b.item_id);
  });
}

function finding(item_id, status, severity, evidence, recommendation, verify_commands = []) {
  const metadata = ITEM_METADATA[item_id] ?? { phase: "Unknown", domain: "미분류" };
  return {
    item_id,
    phase: metadata.phase,
    domain: metadata.domain,
    status,
    severity,
    priority: priorityFor(status, severity),
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

function defaultCommandRunner({ command, args }) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJson(commandRunner, command, args) {
  try {
    const output = commandRunner({ command, args });
    return { ok: true, data: JSON.parse(output || "{}") };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function readText(commandRunner, command, args) {
  try {
    return { ok: true, text: commandRunner({ command, args }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function awsArgs(service, operation, args, { region, profile } = {}) {
  return [
    service,
    operation,
    ...args,
    ...(region ? ["--region", region] : []),
    ...(profile ? ["--profile", profile] : []),
    "--output",
    "json",
  ];
}

function kubectlArgs(args, { context } = {}) {
  return [...args, ...(context ? ["--context", context] : [])];
}

function missingLiveConfig(itemId, missing, verifyCommands) {
  return finding(
    itemId,
    "unknown",
    "medium",
    [`Missing live scan input: ${missing.join(", ")}.`],
    "Provide the missing live scan input and rerun the read-only scanner.",
    verifyCommands,
  );
}

function commandUnknown(itemId, error, recommendation, verifyCommands) {
  return finding(itemId, "unknown", "medium", [`Read-only command failed: ${error}`], recommendation, verifyCommands);
}

function applicationNamespacesFromPods(pods) {
  return new Set(
    (pods.items ?? [])
      .map((pod) => pod.metadata?.namespace ?? "default")
      .filter((namespace) => !SYSTEM_NAMESPACES.has(namespace)),
  );
}

function isEmptySelector(selector) {
  return selector && typeof selector === "object" && Object.keys(selector).length === 0;
}

function liveContainersForPod(pod) {
  return [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])];
}

function workloadPodSpecForLive(item) {
  if (item.kind === "Pod") return item.spec ?? null;
  if (item.kind === "CronJob") return item.spec?.jobTemplate?.spec?.template?.spec ?? null;
  return item.spec?.template?.spec ?? null;
}

function parseEksContextArn(context) {
  const match = /^arn:aws[^:]*:eks:([^:]+):\d+:cluster\/(.+)$/.exec(context ?? "");
  if (!match) return {};
  return { region: match[1], clusterName: match[2] };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

export function detectLiveConfig({ commandRunner = defaultCommandRunner } = {}) {
  const current = readText(commandRunner, "kubectl", ["config", "current-context"]);
  if (!current.ok) return {};

  const context = current.text.trim();
  const fromContext = parseEksContextArn(context);
  const config = readJson(commandRunner, "kubectl", ["config", "view", "--minify", "-o", "json"]);
  const execConfig = config.ok ? config.data.users?.[0]?.user?.exec ?? {} : {};
  const execArgs = execConfig.args ?? [];
  const profile = (execConfig.env ?? []).find((entry) => entry.name === "AWS_PROFILE")?.value ?? null;

  return {
    context,
    clusterName: valueAfter(execArgs, "--cluster-name") ?? fromContext.clusterName ?? null,
    region: valueAfter(execArgs, "--region") ?? fromContext.region ?? null,
    profile,
  };
}

function checkLivePrivateApiEndpoint(options) {
  const verifyCommands = [
    "aws eks describe-cluster --name <cluster-name> --region <region> --query 'cluster.resourcesVpcConfig.{endpointPublicAccess:endpointPublicAccess,endpointPrivateAccess:endpointPrivateAccess}' --output json",
  ];
  const missing = [];
  if (!options.clusterName) missing.push("clusterName");
  if (!options.region) missing.push("region");
  if (missing.length > 0) return missingLiveConfig("foundational/private-api-endpoint", missing, verifyCommands);

  const result = readJson(
    options.commandRunner,
    "aws",
    awsArgs("eks", "describe-cluster", ["--name", options.clusterName], options),
  );
  if (!result.ok) {
    return commandUnknown("foundational/private-api-endpoint", result.error, "Run the EKS cluster endpoint query with read-only AWS credentials.", verifyCommands);
  }

  const config = result.data.cluster?.resourcesVpcConfig ?? {};
  const passes = config.endpointPublicAccess === false && config.endpointPrivateAccess === true;
  return finding(
    "foundational/private-api-endpoint",
    passes ? "pass" : "fail",
    passes ? "low" : "high",
    [`endpointPublicAccess=${String(config.endpointPublicAccess)}, endpointPrivateAccess=${String(config.endpointPrivateAccess)}`],
    "Use a private-only EKS API endpoint for production clusters and require access through approved private network paths.",
    verifyCommands,
  );
}

function checkLivePrivateSubnets(options) {
  const verifyCommands = [
    "aws eks list-nodegroups --cluster-name <cluster-name> --region <region> --output json",
    "aws eks describe-nodegroup --cluster-name <cluster-name> --nodegroup-name <nodegroup> --region <region> --query 'nodegroup.subnets' --output json",
    "aws ec2 describe-subnets --subnet-ids <subnet-ids> --region <region> --query 'Subnets[].{SubnetId:SubnetId,MapPublicIpOnLaunch:MapPublicIpOnLaunch}' --output json",
  ];
  const missing = [];
  if (!options.clusterName) missing.push("clusterName");
  if (!options.region) missing.push("region");
  if (missing.length > 0) return missingLiveConfig("foundational/private-subnets", missing, verifyCommands);

  const nodegroups = readJson(
    options.commandRunner,
    "aws",
    awsArgs("eks", "list-nodegroups", ["--cluster-name", options.clusterName], options),
  );
  if (!nodegroups.ok) {
    return commandUnknown("foundational/private-subnets", nodegroups.error, "List EKS managed nodegroups with read-only AWS credentials.", verifyCommands);
  }

  const subnetIds = new Set();
  for (const nodegroupName of nodegroups.data.nodegroups ?? []) {
    const nodegroup = readJson(
      options.commandRunner,
      "aws",
      awsArgs("eks", "describe-nodegroup", ["--cluster-name", options.clusterName, "--nodegroup-name", nodegroupName], options),
    );
    if (!nodegroup.ok) {
      return commandUnknown("foundational/private-subnets", nodegroup.error, `Describe nodegroup ${nodegroupName} with read-only AWS credentials.`, verifyCommands);
    }
    for (const subnetId of nodegroup.data.nodegroup?.subnets ?? []) subnetIds.add(subnetId);
  }

  if (subnetIds.size === 0) {
    return finding("foundational/private-subnets", "unknown", "medium", ["No EKS managed nodegroup subnets were returned."], "Confirm node placement from self-managed nodegroups, Fargate profiles, or Terraform outputs.", verifyCommands);
  }

  const subnets = readJson(
    options.commandRunner,
    "aws",
    awsArgs("ec2", "describe-subnets", ["--subnet-ids", ...subnetIds], options),
  );
  if (!subnets.ok) {
    return commandUnknown("foundational/private-subnets", subnets.error, "Describe nodegroup subnets with read-only EC2 permissions.", verifyCommands);
  }

  const publicSubnets = (subnets.data.Subnets ?? []).filter((subnet) => subnet.MapPublicIpOnLaunch === true);
  return finding(
    "foundational/private-subnets",
    publicSubnets.length > 0 ? "fail" : "pass",
    publicSubnets.length > 0 ? "high" : "low",
    publicSubnets.length > 0
      ? publicSubnets.map((subnet) => `${subnet.SubnetId} maps public IPs on launch`)
      : [`${subnetIds.size} nodegroup subnet(s) do not map public IPs on launch.`],
    "Place worker nodes and pod networking in private subnets; use controlled egress paths instead of public subnet placement.",
    verifyCommands,
  );
}

function checkLiveDefaultDenyNetworkPolicy(options) {
  const verifyCommands = ["kubectl get pods -A -o json", "kubectl get networkpolicy -A -o json"];
  if (!options.context) return missingLiveConfig("foundational/default-deny-networkpolicy", ["context"], verifyCommands);

  const pods = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pods", "-A", "-o", "json"], options));
  if (!pods.ok) {
    return commandUnknown("foundational/default-deny-networkpolicy", pods.error, "Read pods with kubectl using the selected context.", verifyCommands);
  }

  const workloadNamespaces = applicationNamespacesFromPods(pods.data);
  if (workloadNamespaces.size === 0) {
    return finding("foundational/default-deny-networkpolicy", "unknown", "medium", ["No application workload namespaces were found."], "Run the check after workloads exist or provide namespace scope explicitly.", verifyCommands);
  }

  const policies = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "networkpolicy", "-A", "-o", "json"], options));
  if (!policies.ok) {
    return commandUnknown("foundational/default-deny-networkpolicy", policies.error, "Read NetworkPolicy objects with kubectl using the selected context.", verifyCommands);
  }

  const protectedNamespaces = new Set(
    (policies.data.items ?? [])
      .filter((policy) => isEmptySelector(policy.spec?.podSelector) && (policy.spec?.policyTypes ?? []).some((type) => type === "Ingress" || type === "Egress"))
      .map((policy) => policy.metadata?.namespace ?? "default"),
  );
  const missing = [...workloadNamespaces].filter((namespace) => !protectedNamespaces.has(namespace));

  return finding(
    "foundational/default-deny-networkpolicy",
    missing.length > 0 ? "fail" : "pass",
    missing.length > 0 ? "high" : "low",
    missing.length > 0 ? missing.map((namespace) => `namespace ${namespace} lacks a default deny NetworkPolicy`) : [`${workloadNamespaces.size} workload namespace(s) have default deny NetworkPolicy coverage.`],
    "Apply namespace-level default deny NetworkPolicy before adding explicit workload allow rules.",
    verifyCommands,
  );
}

function checkLivePodSecurityBaseline(options) {
  const verifyCommands = [
    "kubectl get namespaces -o json",
    "kubectl get pods -A -o json",
  ];
  if (!options.context) return missingLiveConfig("foundational/pod-실행-권한-최소화", ["context"], verifyCommands);

  const namespaces = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "namespaces", "-o", "json"], options));
  if (!namespaces.ok) {
    return commandUnknown("foundational/pod-실행-권한-최소화", namespaces.error, "Read namespace labels with kubectl using the selected context.", verifyCommands);
  }

  const pods = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pods", "-A", "-o", "json"], options));
  if (!pods.ok) {
    return commandUnknown("foundational/pod-실행-권한-최소화", pods.error, "Read pod specs with kubectl using the selected context.", verifyCommands);
  }

  const workloadNamespaces = applicationNamespacesFromPods(pods.data);
  if (workloadNamespaces.size === 0) {
    return finding("foundational/pod-실행-권한-최소화", "unknown", "medium", ["No application workload namespaces were found."], "Run the check after workloads exist or provide namespace scope explicitly.", verifyCommands);
  }

  const labelsByNamespace = new Map((namespaces.data.items ?? []).map((namespace) => [namespace.metadata?.name, namespace.metadata?.labels ?? {}]));
  const failures = [];
  for (const namespace of workloadNamespaces) {
    const enforce = labelsByNamespace.get(namespace)?.["pod-security.kubernetes.io/enforce"];
    if (enforce !== "baseline" && enforce !== "restricted") {
      failures.push(`namespace ${namespace} does not enforce PSS baseline or restricted`);
    }
  }

  for (const pod of pods.data.items ?? []) {
    const namespace = pod.metadata?.namespace ?? "default";
    if (!workloadNamespaces.has(namespace)) continue;
    for (const container of liveContainersForPod(pod)) {
      if (container.securityContext?.privileged === true) {
        failures.push(`${namespace}/${pod.metadata?.name ?? "<unnamed>"} container ${container.name ?? "<unnamed>"} is privileged`);
      }
    }
  }

  return finding(
    "foundational/pod-실행-권한-최소화",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : [`${workloadNamespaces.size} workload namespace(s) enforce PSS baseline/restricted and no privileged containers were observed.`],
    "Enforce Pod Security Standards at least at baseline and remove privileged container execution from application namespaces.",
    verifyCommands,
  );
}

function checkLiveIamK8sMapping(options) {
  const verifyCommands = [
    "aws eks describe-cluster --name <cluster-name> --region <region> --query 'cluster.accessConfig' --output json",
    "aws eks list-access-entries --cluster-name <cluster-name> --region <region> --output json",
  ];
  const missing = [];
  if (!options.clusterName) missing.push("clusterName");
  if (!options.region) missing.push("region");
  if (missing.length > 0) return missingLiveConfig("foundational/iam-k8s-mapping", missing, verifyCommands);

  const cluster = readJson(
    options.commandRunner,
    "aws",
    awsArgs("eks", "describe-cluster", ["--name", options.clusterName], options),
  );
  if (!cluster.ok) {
    return commandUnknown("foundational/iam-k8s-mapping", cluster.error, "Read EKS access configuration with read-only AWS credentials.", verifyCommands);
  }

  const entries = readJson(
    options.commandRunner,
    "aws",
    awsArgs("eks", "list-access-entries", ["--cluster-name", options.clusterName], options),
  );
  if (!entries.ok) {
    return commandUnknown("foundational/iam-k8s-mapping", entries.error, "List EKS access entries with read-only AWS credentials.", verifyCommands);
  }

  const authenticationMode = cluster.data.cluster?.accessConfig?.authenticationMode ?? "unknown";
  const accessEntries = entries.data.accessEntries ?? [];
  const usesApi = authenticationMode.includes("API");
  const passes = usesApi && accessEntries.length > 0;
  const status = passes ? "pass" : usesApi ? "warn" : "fail";

  return finding(
    "foundational/iam-k8s-mapping",
    status,
    passes ? "low" : usesApi ? "medium" : "high",
    [`authenticationMode=${authenticationMode}, accessEntries=${accessEntries.length}`],
    "Manage cluster access with EKS Access Entries and keep IAM-to-Kubernetes access mappings explicit and reviewable.",
    verifyCommands,
  );
}

function checkLiveContainerImageTriage(options) {
  const verifyCommands = [
    "aws inspector2 list-filters --action SUPPRESS --region <region> --output json",
    "aws inspector2 list-findings --region <region> --filter-criteria '<critical-high-ecr-active-filter>' --output json",
  ];
  if (!options.region) return missingLiveConfig("foundational/container-image-취약점-관리", ["region"], verifyCommands);

  const filters = readJson(options.commandRunner, "aws", awsArgs("inspector2", "list-filters", ["--action", "SUPPRESS"], options));
  if (!filters.ok) {
    return commandUnknown("foundational/container-image-취약점-관리", filters.error, "List Inspector suppression filters with read-only AWS credentials.", verifyCommands);
  }

  const findings = readJson(
    options.commandRunner,
    "aws",
    awsArgs("inspector2", "list-findings", [
      "--filter-criteria",
      '{"resourceType":[{"comparison":"EQUALS","value":"AWS_ECR_CONTAINER_IMAGE"}],"findingStatus":[{"comparison":"EQUALS","value":"ACTIVE"}],"severity":[{"comparison":"EQUALS","value":"CRITICAL"},{"comparison":"EQUALS","value":"HIGH"}]}',
    ], options),
  );
  if (!findings.ok) {
    return commandUnknown("foundational/container-image-취약점-관리", findings.error, "List active Critical/High ECR Inspector findings with read-only AWS credentials.", verifyCommands);
  }

  const suppressFilters = filters.data.filters ?? [];
  const activeFindings = findings.data.findings ?? [];
  const status = activeFindings.length > 0 ? "fail" : suppressFilters.length > 0 ? "pass" : "warn";
  return finding(
    "foundational/container-image-취약점-관리",
    status,
    activeFindings.length > 0 ? "high" : status === "warn" ? "medium" : "low",
    [
      `${suppressFilters.length} Inspector suppression filter(s) found.`,
      `${activeFindings.length} active Critical/High ECR finding(s) found.`,
    ],
    "Maintain documented Inspector triage suppression filters and remediate active Critical/High ECR findings within the agreed SLA.",
    verifyCommands,
  );
}

function checkLiveGrafana(options) {
  const verifyCommands = [
    "kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana -o json",
    "kubectl get pvc -n monitoring -o json",
    "kubectl get ingress -n monitoring -o json",
  ];
  if (!options.context) return missingLiveConfig("foundational/grafana-대시보드-연결", ["context"], verifyCommands);

  const pods = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pods", "-n", "monitoring", "-l", "app.kubernetes.io/name=grafana", "-o", "json"], options));
  if (!pods.ok) return commandUnknown("foundational/grafana-대시보드-연결", pods.error, "Read Grafana pods from the monitoring namespace.", verifyCommands);

  const pvcs = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pvc", "-n", "monitoring", "-o", "json"], options));
  if (!pvcs.ok) return commandUnknown("foundational/grafana-대시보드-연결", pvcs.error, "Read Grafana PVCs from the monitoring namespace.", verifyCommands);

  const ingresses = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "ingress", "-n", "monitoring", "-o", "json"], options));
  if (!ingresses.ok) return commandUnknown("foundational/grafana-대시보드-연결", ingresses.error, "Read Grafana ingress from the monitoring namespace.", verifyCommands);

  const runningPods = (pods.data.items ?? []).filter((pod) => pod.status?.phase === "Running");
  const grafanaPvcs = (pvcs.data.items ?? []).filter((pvc) => /grafana/i.test(pvc.metadata?.name ?? ""));
  const boundPvcs = grafanaPvcs.filter((pvc) => pvc.status?.phase === "Bound");
  const hasIngress = (ingresses.data.items ?? []).length > 0;
  const failures = [];
  if (runningPods.length === 0) failures.push("No Running Grafana pod was found in namespace monitoring.");
  if (grafanaPvcs.length > 0 && boundPvcs.length !== grafanaPvcs.length) failures.push("One or more Grafana PVCs are not Bound.");
  if (!hasIngress) failures.push("No Grafana ingress was found in namespace monitoring.");

  return finding(
    "foundational/grafana-대시보드-연결",
    failures.length > 0 ? "warn" : "pass",
    failures.length > 0 ? "medium" : "low",
    failures.length > 0 ? failures : [`${runningPods.length} Grafana pod(s) Running, ${boundPvcs.length} Grafana PVC(s) Bound, and ingress exists.`],
    "Keep Grafana running with persistent encrypted storage and an explicitly reviewed access path.",
    verifyCommands,
  );
}

function volumeIdFromHandle(handle) {
  if (!handle) return null;
  const match = /(vol-[a-zA-Z0-9]+)/.exec(handle);
  return match?.[1] ?? null;
}

function checkLiveEbsStorageProtection(options) {
  const verifyCommands = [
    "aws ec2 get-ebs-encryption-by-default --region <region> --output json",
    "kubectl get storageclass -o json",
    "kubectl get pvc -A -o json",
    "kubectl get pv -o json",
  ];
  const missing = [];
  if (!options.region) missing.push("region");
  if (!options.context) missing.push("context");
  if (missing.length > 0) return missingLiveConfig("foundational/ebs-기반-workload-storage-data-보호", missing, verifyCommands);

  const defaultEncryption = readJson(options.commandRunner, "aws", awsArgs("ec2", "get-ebs-encryption-by-default", [], options));
  if (!defaultEncryption.ok) return commandUnknown("foundational/ebs-기반-workload-storage-data-보호", defaultEncryption.error, "Read EBS default encryption state with read-only AWS credentials.", verifyCommands);

  const storageClasses = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "storageclass", "-o", "json"], options));
  if (!storageClasses.ok) return commandUnknown("foundational/ebs-기반-workload-storage-data-보호", storageClasses.error, "Read StorageClass objects with kubectl.", verifyCommands);

  const pvcs = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pvc", "-A", "-o", "json"], options));
  if (!pvcs.ok) return commandUnknown("foundational/ebs-기반-workload-storage-data-보호", pvcs.error, "Read PVC objects with kubectl.", verifyCommands);

  const pvs = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "pv", "-o", "json"], options));
  if (!pvs.ok) return commandUnknown("foundational/ebs-기반-workload-storage-data-보호", pvs.error, "Read PV objects with kubectl.", verifyCommands);

  const failures = [];
  if (defaultEncryption.data.EbsEncryptionByDefault !== true) failures.push("AWS EBS encryption by default is not enabled in this region.");

  const classByName = new Map((storageClasses.data.items ?? []).map((storageClass) => [storageClass.metadata?.name, storageClass]));
  for (const storageClass of storageClasses.data.items ?? []) {
    if (storageClass.provisioner === "ebs.csi.aws.com" || storageClass.provisioner === "kubernetes.io/aws-ebs") {
      if (String(storageClass.parameters?.encrypted).toLowerCase() !== "true") {
        failures.push(`StorageClass ${storageClass.metadata?.name ?? "<unnamed>"} does not set parameters.encrypted=true`);
      }
    }
  }

  for (const pvc of pvcs.data.items ?? []) {
    const storageClassName = pvc.spec?.storageClassName;
    if (!storageClassName || !classByName.has(storageClassName)) {
      failures.push(`${pvc.metadata?.namespace ?? "default"}/${pvc.metadata?.name ?? "<unnamed>"} does not reference a known encrypted StorageClass`);
    }
  }

  const volumeIds = (pvs.data.items ?? [])
    .map((pv) => volumeIdFromHandle(pv.spec?.csi?.volumeHandle ?? pv.spec?.awsElasticBlockStore?.volumeID))
    .filter(Boolean);
  if (volumeIds.length > 0) {
    const volumes = readJson(options.commandRunner, "aws", awsArgs("ec2", "describe-volumes", ["--volume-ids", ...volumeIds], options));
    if (!volumes.ok) return commandUnknown("foundational/ebs-기반-workload-storage-data-보호", volumes.error, "Describe backing EBS volumes with read-only AWS credentials.", verifyCommands);
    for (const volume of volumes.data.Volumes ?? []) {
      if (volume.Encrypted !== true) failures.push(`EBS volume ${volume.VolumeId} is not encrypted`);
    }
  }

  return finding(
    "foundational/ebs-기반-workload-storage-data-보호",
    failures.length > 0 ? "fail" : "pass",
    failures.length > 0 ? "high" : "low",
    failures.length > 0 ? failures : ["EBS default encryption, StorageClass encryption, PVC references, and observed EBS PV volumes are encrypted."],
    "Enable EBS encryption by default, require encrypted EBS CSI StorageClasses, and migrate any unencrypted PV-backed workloads.",
    verifyCommands,
  );
}

function checkLiveHardcodedSecretRemoval(options) {
  const verifyCommands = [
    "kubectl get externalsecrets -A -o json",
    "kubectl get deployments,statefulsets,daemonsets,jobs,cronjobs -A -o json",
  ];
  if (!options.context) return missingLiveConfig("foundational/workload-내-hardcoded-secret-제거", ["context"], verifyCommands);

  const externalSecrets = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "externalsecrets", "-A", "-o", "json"], options));
  if (!externalSecrets.ok) return commandUnknown("foundational/workload-내-hardcoded-secret-제거", externalSecrets.error, "Read ExternalSecret objects with kubectl; if the CRD is absent, install or document the chosen external secret path.", verifyCommands);

  const workloads = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "deployments,statefulsets,daemonsets,jobs,cronjobs", "-A", "-o", "json"], options));
  if (!workloads.ok) return commandUnknown("foundational/workload-내-hardcoded-secret-제거", workloads.error, "Read workload env configuration with kubectl.", verifyCommands);

  const failures = (workloads.data.items ?? [])
    .filter((item) => hasHardcodedSecret(workloadPodSpecForLive(item)))
    .map((item) => `${item.metadata?.namespace ?? "default"}/${item.kind ?? "Workload"}/${item.metadata?.name ?? "<unnamed>"} contains an env-style secret literal`);
  const externalSecretCount = (externalSecrets.data.items ?? []).length;
  const status = failures.length > 0 ? "fail" : externalSecretCount > 0 ? "pass" : "warn";

  return finding(
    "foundational/workload-내-hardcoded-secret-제거",
    status,
    failures.length > 0 ? "high" : status === "warn" ? "medium" : "low",
    failures.length > 0 ? failures : [`${externalSecretCount} ExternalSecret object(s) found and no secret-like literal env values were observed.`],
    "Move runtime secrets to AWS Secrets Manager or an approved external secret path and reference them through valueFrom, ESO, CSI, or runtime lookup.",
    verifyCommands,
  );
}

function isDefaultRbacObject(item) {
  const name = item.metadata?.name ?? "";
  const labels = item.metadata?.labels ?? {};
  return name.startsWith("system:") || labels["kubernetes.io/bootstrapping"] === "rbac-defaults";
}

function hasWildcardRule(item) {
  return (item.rules ?? []).some((rule) => (rule.verbs ?? []).includes("*") || (rule.resources ?? []).includes("*"));
}

function checkLiveRbac(options) {
  const verifyCommands = [
    "kubectl get roles,rolebindings -A -o json",
    "kubectl get clusterroles,clusterrolebindings -o json",
  ];
  if (!options.context) return missingLiveConfig("foundational/cluster내-리소스-접근제어", ["context"], verifyCommands);

  const namespaced = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "roles,rolebindings", "-A", "-o", "json"], options));
  if (!namespaced.ok) return commandUnknown("foundational/cluster내-리소스-접근제어", namespaced.error, "Read namespaced RBAC objects with kubectl.", verifyCommands);

  const cluster = readJson(options.commandRunner, "kubectl", kubectlArgs(["get", "clusterroles,clusterrolebindings", "-o", "json"], options));
  if (!cluster.ok) return commandUnknown("foundational/cluster내-리소스-접근제어", cluster.error, "Read cluster RBAC objects with kubectl.", verifyCommands);

  const items = [...(namespaced.data.items ?? []), ...(cluster.data.items ?? [])];
  const failures = [];
  for (const item of items) {
    if ((item.kind === "Role" || item.kind === "ClusterRole") && !isDefaultRbacObject(item) && hasWildcardRule(item)) {
      failures.push(`${item.kind}/${item.metadata?.name ?? "<unnamed>"} uses wildcard RBAC permissions`);
    }
    if (item.kind === "ClusterRoleBinding" && item.roleRef?.name === "cluster-admin" && !isDefaultRbacObject(item)) {
      failures.push(`ClusterRoleBinding/${item.metadata?.name ?? "<unnamed>"} binds cluster-admin`);
    }
  }

  const roleBindings = items.filter((item) => item.kind === "RoleBinding").length;
  const status = failures.length > 0 ? "fail" : roleBindings > 0 ? "pass" : "warn";
  return finding(
    "foundational/cluster내-리소스-접근제어",
    status,
    failures.length > 0 ? "high" : status === "warn" ? "medium" : "low",
    failures.length > 0 ? failures : [`${roleBindings} RoleBinding object(s) found and no custom wildcard RBAC or cluster-admin bindings were observed.`],
    "Keep namespace RBAC explicit, avoid wildcard permissions, and restrict ClusterRoleBinding usage to reviewed platform roles.",
    verifyCommands,
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
    findings: sortFindings(findings),
  };
}

export function scanLiveCluster({ clusterName, context, region, profile, autoDetect = false, commandRunner = defaultCommandRunner } = {}) {
  const detected = autoDetect ? detectLiveConfig({ commandRunner }) : {};
  const options = {
    clusterName: clusterName ?? detected.clusterName,
    context: context ?? detected.context,
    region: region ?? detected.region,
    profile: profile ?? detected.profile,
    commandRunner,
  };
  const findings = [
    checkLivePrivateApiEndpoint(options),
    checkLivePrivateSubnets(options),
    checkLiveDefaultDenyNetworkPolicy(options),
    checkLivePodSecurityBaseline(options),
    checkLiveIamK8sMapping(options),
    checkLiveContainerImageTriage(options),
    checkLiveGrafana(options),
    checkLiveEbsStorageProtection(options),
    checkLiveHardcodedSecretRemoval(options),
    checkLiveRbac(options),
  ];

  return {
    scanner: "eks-maturity-advisor",
    mode: "live-cluster",
    cluster_name: options.clusterName ?? null,
    kubectl_context: options.context ?? null,
    region: options.region ?? null,
    aws_profile: options.profile ?? null,
    findings: sortFindings(findings),
  };
}

export function renderMarkdown(report) {
  const lines = ["# EKS Maturity Advisor Report", "", `Mode: ${report.mode}`, ""];
  for (const finding of report.findings) {
    lines.push(`## ${finding.item_id}`, "", `Phase: ${finding.phase}`, `Domain: ${finding.domain}`, `Status: ${finding.status}`, `Severity: ${finding.severity}`, `Priority: ${finding.priority}`, "", "Evidence:");
    for (const item of finding.evidence) lines.push(`- ${item}`);
    lines.push("", `Recommendation: ${finding.recommendation}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), output: "json", live: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") args.repoRoot = argv[++index];
    if (arg === "--output") args.output = argv[++index];
    if (arg === "--live") args.live = true;
    if (arg === "--context") args.context = argv[++index];
    if (arg === "--cluster-name") args.clusterName = argv[++index];
    if (arg === "--region") args.region = argv[++index];
    if (arg === "--profile") args.profile = argv[++index];
    if (arg === "--auto-detect") args.autoDetect = true;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const report = args.live ? scanLiveCluster(args) : scanRepository({ repoRoot: args.repoRoot });
  process.stdout.write(args.output === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
}
