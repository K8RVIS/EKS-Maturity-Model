# EKS Maturity Advisor v1.1 Design

## Goal

Extend `eks-maturity-advisor` from repo-only Quick Wins scanning to read-only live cluster assessment for the v1.1 Foundational slice, while improving scanner finding prioritization.

## Scope

v1.1 implements live, read-only automation for these Foundational controls:

- `foundational/private-api-endpoint`
- `foundational/private-subnets`
- `foundational/default-deny-networkpolicy`
- `foundational/pod-실행-권한-최소화`
- `foundational/iam-k8s-mapping`

The remaining Foundational items stay in v1.2: Grafana, Inspector triage, EBS workload storage protection, hardcoded secret removal beyond existing Quick Wins static detection, and detailed RBAC validation.

## CLI Behavior

The scanner keeps repo-only mode as the default:

```bash
node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs --repo-root . --output json
```

Live mode is explicit and read-only:

```bash
node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs \
  --live \
  --context <kubectl-context> \
  --cluster-name <cluster-name> \
  --region <aws-region> \
  --output json
```

Live mode may also combine with repo scanning when `--repo-root` is provided. Missing `kubectl`, missing `aws`, access denial, or missing flags must not crash the report. The relevant finding becomes `unknown` with evidence and the read-only command needed to verify manually.

## Architecture

`scan_eks_maturity.mjs` remains the scanner entry point. It gains a small command runner abstraction so tests can inject mocked `kubectl` and `aws` outputs without touching a live cluster.

Findings use a richer shape:

```text
item_id, phase, domain, status, severity, priority, evidence, recommendation, verify_commands, source_reference
```

`priority` is derived from status and severity. Failed high-severity findings come first, then medium failures, warnings, unknowns, and passes. Markdown output follows the same order.

## Foundational Checks

`private-api-endpoint` reads `aws eks describe-cluster` and passes only when `endpointPublicAccess=false` and `endpointPrivateAccess=true`.

`private-subnets` reads EKS nodegroup subnet IDs plus EC2 subnet metadata. It passes when nodegroup subnets do not map public IPs on launch. If subnet metadata cannot be read, it returns `unknown`.

`default-deny-networkpolicy` reads `kubectl get networkpolicy -A -o json`. It passes when each namespace with workload pods has a NetworkPolicy with empty `podSelector` and at least one of `Ingress` or `Egress` policy types. Missing default deny is a failure.

`pod-실행-권한-최소화` reads namespace labels and workload pod specs. It passes when workload namespaces enforce at least `baseline` and workloads avoid privileged containers.

`iam-k8s-mapping` reads `aws eks describe-cluster --query cluster.accessConfig` and `aws eks list-access-entries`. It passes when authentication mode includes API and at least one access entry exists. Legacy-only or missing access entries is a warning or failure depending on evidence.

## Safety

The scanner only runs `kubectl get`, `aws eks describe-*`, `aws eks list-*`, and `aws ec2 describe-*` commands. It never runs mutation commands. Recommendations can mention changes, but verify commands remain read-only.

## Testing

Tests cover:

- live mode with mocked successful `kubectl` and `aws` outputs
- missing live tooling or missing flags returning `unknown`
- priority ordering and severity fields
- existing repo-only Quick Wins behavior staying intact

