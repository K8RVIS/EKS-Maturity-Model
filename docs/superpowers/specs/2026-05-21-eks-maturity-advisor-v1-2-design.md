# EKS Maturity Advisor v1.2 Design

## Goal

Complete live read-only automation for the Foundational phase and make live scan inputs discoverable from the current EKS kubeconfig.

## Scope

v1.2 adds live checks for the five Foundational controls deferred from v1.1:

- `foundational/container-image-취약점-관리`
- `foundational/grafana-대시보드-연결`
- `foundational/ebs-기반-workload-storage-data-보호`
- `foundational/workload-내-hardcoded-secret-제거`
- `foundational/cluster내-리소스-접근제어`

It also adds `--auto-detect`, which reads `kubectl config current-context` and `kubectl config view --minify -o json` to infer EKS cluster name, region, kubectl context, and AWS profile. Explicit CLI flags override detected values.

## Safety

The scanner remains read-only. It uses `kubectl get`, `kubectl config`, `aws eks describe/list`, `aws ec2 describe/get`, and `aws inspector2 list` commands. It never runs `kubectl apply`, `kubectl auth can-i --as` mutation-adjacent workflows, `port-forward`, Terraform apply, Helm upgrade, or any AWS update/delete operation.

## Behavior

If no live cluster exists or credentials are expired, findings return `unknown` with evidence and verification commands. This keeps the skill useful before an EKS cluster is created and allows a later acceptance run against an ephemeral dev cluster.

The current local kubeconfig points at `eks-secure-infra-dev` in `ap-northeast-2` with `AWS_PROFILE=eks-security-infra`, but live verification is blocked until AWS SSO is refreshed and a cluster is reachable.

## Testing

Tests mock all `kubectl` and `aws` command output. They verify the 10 Foundational findings, auto-detection, failure-to-unknown behavior, and that missing explicit inputs do not query the current kubectl context unless `--auto-detect` is set.

