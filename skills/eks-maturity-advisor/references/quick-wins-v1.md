# EKS Maturity Advisor Scanner Reference

The scanner performs repo-only static checks for five Quick Wins controls and v1.1 read-only live checks for the approved Foundational slice. It does not mutate files, clusters, or AWS resources.

## Repo-Only Quick Wins Controls

| item_id | Static rule | Notes |
| --- | --- | --- |
| `quick-wins/non-root-containers` | Every workload container must avoid UID 0 and resolve to `runAsNonRoot: true` from pod or container `securityContext`. | A pass means the manifest declares non-root execution; it does not prove the image itself runs correctly as non-root. |
| `quick-wins/default-service-account` | Every workload must set a non-default `serviceAccountName` and `automountServiceAccountToken: false`. | Workloads needing Kubernetes API access require a separate RBAC review. |
| `quick-wins/ingress-load-balancer-tls` | Each Ingress must use `spec.tls` or AWS Load Balancer Controller HTTPS certificate annotations. | ALB checks require both `alb.ingress.kubernetes.io/certificate-arn` and HTTPS listener annotations. |
| `quick-wins/resource-quota-limitrange` | Every namespace with workloads must include both `ResourceQuota` and `LimitRange`. | The scanner checks presence, not whether quota values are operationally appropriate. |
| `quick-wins/aws-secret-manager-사용` | Secret-like `env[].name` entries must not use literal `value`. | This is a signal check for the external secret storage control; full secret scanning needs a dedicated scanner such as gitleaks. |

## Live Foundational v1.1 Controls

| item_id | Read-only rule | Commands |
| --- | --- | --- |
| `foundational/private-api-endpoint` | EKS API endpoint must have `endpointPublicAccess=false` and `endpointPrivateAccess=true`. | `aws eks describe-cluster` |
| `foundational/private-subnets` | EKS managed nodegroup subnets must not map public IPs on launch. | `aws eks list-nodegroups`, `aws eks describe-nodegroup`, `aws ec2 describe-subnets` |
| `foundational/default-deny-networkpolicy` | Each namespace with application pods must have an empty-selector default deny NetworkPolicy. | `kubectl get pods`, `kubectl get networkpolicy` |
| `foundational/pod-실행-권한-최소화` | Application namespaces must enforce PSS `baseline` or `restricted`, and observed pods must not run privileged containers. | `kubectl get namespaces`, `kubectl get pods` |
| `foundational/iam-k8s-mapping` | EKS access config should use API-backed authentication and have Access Entries. | `aws eks describe-cluster`, `aws eks list-access-entries` |

Deferred to v1.2: Grafana, Inspector triage, EBS workload storage protection, hardcoded secret removal beyond static manifest signals, and detailed RBAC validation.

## Reporting Guidance

Lead with `P1` findings, then `P2`, then `P3`. Within the same priority, show `fail`, `warn`, `unknown`, then `pass`. For each failed finding, cite the evidence path or command output and explain the smallest remediation that moves the environment toward the maturity item. Keep verification commands read-only.

Use `unknown` when manifests are absent rather than assuming a control is missing in production.
