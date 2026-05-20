# Quick Wins v1 Scanner Reference

v1 performs repo-only static checks for five Quick Wins controls. It does not mutate files or query live clusters.

## Controls

| item_id | Static rule | Notes |
| --- | --- | --- |
| `quick-wins/non-root-containers` | Every workload container must avoid UID 0 and resolve to `runAsNonRoot: true` from pod or container `securityContext`. | A pass means the manifest declares non-root execution; it does not prove the image itself runs correctly as non-root. |
| `quick-wins/default-service-account` | Every workload must set a non-default `serviceAccountName` and `automountServiceAccountToken: false`. | Workloads needing Kubernetes API access require a separate RBAC review. |
| `quick-wins/ingress-load-balancer-tls` | Each Ingress must use `spec.tls` or AWS Load Balancer Controller HTTPS certificate annotations. | ALB checks require both `alb.ingress.kubernetes.io/certificate-arn` and HTTPS listener annotations. |
| `quick-wins/resource-quota-limitrange` | Every namespace with workloads must include both `ResourceQuota` and `LimitRange`. | The scanner checks presence, not whether quota values are operationally appropriate. |
| `quick-wins/aws-secret-manager-사용` | Secret-like `env[].name` entries must not use literal `value`. | This is a signal check for the external secret storage control; full secret scanning needs a dedicated scanner such as gitleaks. |

## Reporting Guidance

Lead with `fail` findings, then `unknown`, then `pass`. For each failed finding, cite the evidence path and explain the smallest remediation that moves the repo toward the maturity item. Keep verification commands read-only.

Use `unknown` when manifests are absent rather than assuming a control is missing in production.
