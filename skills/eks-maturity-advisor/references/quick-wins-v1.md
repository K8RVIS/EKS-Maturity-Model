# EKS Maturity Advisor Scanner Reference

The scanner performs repo-only static checks for five Quick Wins controls and read-only live checks for all Foundational controls. It does not mutate files, clusters, or AWS resources.

## Repo-Only Quick Wins Controls

| item_id | Static rule | Notes |
| --- | --- | --- |
| `quick-wins/non-root-containers` | Every workload container must avoid UID 0 and resolve to `runAsNonRoot: true` from pod or container `securityContext`. | A pass means the manifest declares non-root execution; it does not prove the image itself runs correctly as non-root. |
| `quick-wins/default-service-account` | Every workload must set a non-default `serviceAccountName` and `automountServiceAccountToken: false`. | Workloads needing Kubernetes API access require a separate RBAC review. |
| `quick-wins/ingress-load-balancer-tls` | Each Ingress must use `spec.tls` or AWS Load Balancer Controller HTTPS certificate annotations. | ALB checks require both `alb.ingress.kubernetes.io/certificate-arn` and HTTPS listener annotations. |
| `quick-wins/resource-quota-limitrange` | Every namespace with workloads must include both `ResourceQuota` and `LimitRange`. | The scanner checks presence, not whether quota values are operationally appropriate. |
| `quick-wins/aws-secret-manager-사용` | Secret-like `env[].name` entries must not use literal `value`. | This is a signal check for the external secret storage control; full secret scanning needs a dedicated scanner such as gitleaks. |

## Live Foundational Controls

| item_id | Read-only rule | Commands |
| --- | --- | --- |
| `foundational/private-api-endpoint` | EKS API endpoint must have `endpointPublicAccess=false` and `endpointPrivateAccess=true`. | `aws eks describe-cluster` |
| `foundational/private-subnets` | EKS managed nodegroup subnets must not map public IPs on launch. | `aws eks list-nodegroups`, `aws eks describe-nodegroup`, `aws ec2 describe-subnets` |
| `efficient/default-deny-networkpolicy` | Each namespace with application pods must have an empty-selector default deny NetworkPolicy. | `kubectl get pods`, `kubectl get networkpolicy` |
| `foundational/pod-실행-권한-최소화` | Application namespaces must enforce PSS `baseline` or `restricted`, and observed pods must not run privileged containers. | `kubectl get namespaces`, `kubectl get pods` |
| `foundational/iam-k8s-mapping` | EKS access config should use API-backed authentication and have Access Entries. | `aws eks describe-cluster`, `aws eks list-access-entries` |
| `foundational/container-image-취약점-관리` | Inspector suppression filters should exist and no active Critical/High ECR findings should remain. | `aws inspector2 list-filters`, `aws inspector2 list-findings` |
| `foundational/grafana-대시보드-연결` | Grafana should have a Running pod, Bound PVC, and reviewed ingress path. | `kubectl get pods`, `kubectl get pvc`, `kubectl get ingress` |
| `foundational/ebs-기반-workload-storage-data-보호` | EBS default encryption, EBS StorageClasses, PVC references, and observed EBS volumes should be encrypted. | `aws ec2 get-ebs-encryption-by-default`, `kubectl get storageclass`, `kubectl get pvc`, `kubectl get pv`, `aws ec2 describe-volumes` |
| `foundational/workload-내-hardcoded-secret-제거` | Workloads should avoid secret-like literal env values and use ExternalSecrets or an equivalent external secret path. | `kubectl get externalsecrets`, `kubectl get deployments,statefulsets,daemonsets,jobs,cronjobs` |
| `foundational/cluster내-리소스-접근제어` | RBAC should avoid custom wildcard permissions and unreviewed cluster-admin bindings. | `kubectl get roles,rolebindings`, `kubectl get clusterroles,clusterrolebindings` |

Use `--auto-detect` to infer EKS cluster name, region, context, and AWS profile from the current kubeconfig. Explicit CLI flags override detected values.

## Reporting Guidance

Lead with `P1` findings, then `P2`, then `P3`. Within the same priority, show `fail`, `warn`, `unknown`, then `pass`. For each failed finding, cite the evidence path or command output and explain the smallest remediation that moves the environment toward the maturity item. Keep verification commands read-only.

Use `unknown` when manifests are absent rather than assuming a control is missing in production.
