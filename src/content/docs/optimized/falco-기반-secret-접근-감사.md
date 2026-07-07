---
title: "Falco 기반 Secret 접근 감사를 보완한다"
description: "Efficient 단계의 Secret 접근 감사는 EKS audit log와 CloudTrail을 사용해 Kubernetes API 또는 AWS API 기반 Secret 접근을 추적한다. 이 방식은 `kubectl get secret`, controller의 Secre"
phase: "Optimized"
domain: "데이터 보호"
difficulty: "★★★"
owner: "공통 (전체 실습)"
order: 40
sidebar:
  order: 40
---

## 왜 필요한가

Efficient 단계의 Secret 접근 감사는 EKS audit log와 CloudTrail을 사용해 Kubernetes API 또는 AWS API 기반 Secret 접근을 추적한다. 이 방식은 `kubectl get secret`, controller의 Secret 조회, Secrets Manager `GetSecretValue` 같은 API 이벤트를 확인하는 데 적합하다.

하지만 Pod 내부에 이미 주입된 Secret 파일을 프로세스가 직접 읽는 행위는 Kubernetes API audit log에 다시 남지 않는다. 컨테이너 shell에서 `/etc/secrets`, `/var/run/secrets`, `/proc/*/environ`을 탐색하거나, 기본 ServiceAccount token을 읽는 행위도 control plane 감사만으로는 충분히 보이지 않는다.

이러한 공백을 보완하기 위해 Falco를 Terraform `helm_release`로 배포하고, 컨테이너 런타임에서 Secret 관련 파일 접근을 탐지하는 custom rule을 추가하여 API 감사로 보기 어려운 data plane/runtime 영역을 보완하고자 한다.

이 항목의 목표는 다음과 같다.

- EKS audit log와 CloudTrail 기반 Secret 접근 감사의 한계를 명확히 보완한다.
- Falco DaemonSet을 모든 노드에 배포해 컨테이너 런타임 Secret 접근을 탐지한다.
- Secret mount path 조회, Secret 파일 read, ServiceAccount token read, `/proc/*/environ` read, 컨테이너 shell 실행을 탐지한다.


## 수행 방법

**사전 조건**

- EKS 클러스터에 Falco를 DaemonSet으로 실행할 수 있어야 한다.
- Helm provider를 사용하는 Terraform platform 환경이 준비되어 있어야 한다.
- Falco가 노드의 syscall 또는 eBPF 기반 이벤트를 수집할 수 있도록 필요한 권한과 runtime 지원을 확인해야 한다.
- CloudWatch, stdout log 수집, SIEM 중 Falco alert를 보관할 경로를 정해야 한다.
- Efficient 단계의 EKS audit/authenticator 로그와 CloudTrail 기반 Secret 접근 감사가 함께 운영되는 것이 권장된다.

### Step 1: Falco 모듈을 platform 환경에 연결한다

`modules/falco`를 추가하고 platform 환경에서 호출한다.

```hcl
module "falco" {
  source = "../../modules/falco"

  helm_release_timeout_seconds = var.helm_release_timeout_seconds
  falco_namespace              = var.falco_namespace
  falco_chart_version          = var.falco_chart_version

  depends_on = [module.k8s_base]
}
```

Argo CD 같은 GitOps 도구가 이후 배포될 경우 Falco가 먼저 준비되도록 의존성을 둔다.

```hcl
module "argocd" {
  source = "../../modules/argocd"

  depends_on = [
    module.k8s_base,
    module.falco,
    module.namespaces,
  ]
}
```

Falco는 노드 단위 runtime 탐지 도구이므로 특정 team namespace 안에 배포하지 않고 별도 `falco` namespace에 클러스터 공통 애드온으로 배포한다.

### Step 2: Falco Helm release를 Terraform으로 배포한다

Falco 모듈은 Helm provider를 사용한다.

```hcl
terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }
}
```

`helm_release`는 chart version을 pinning하고, 실패 시 정리되도록 설정한다.

```hcl
resource "helm_release" "falco" {
  name             = "falco"
  namespace        = var.falco_namespace
  create_namespace = true
  repository       = "https://falcosecurity.github.io/charts"
  chart            = "falco"
  version          = var.falco_chart_version
  timeout          = var.helm_release_timeout_seconds
  atomic           = true
  cleanup_on_fail  = true
  wait             = true

  values = [
    yamlencode(merge(local.falco_values, {
      customRules = {
        "falco-custom-rules.yaml" = local.falco_custom_rules
      }
    }))
  ]
}
```

기본 변수는 다음처럼 둔다.

```hcl
variable "falco_namespace" {
  description = "Namespace used for the Falco release."
  type        = string
  default     = "falco"
}

variable "falco_chart_version" {
  description = "Pinned chart version for Falco."
  type        = string
  default     = "8.0.5"
}
```

### Step 3: Falco alert 출력 형식을 운영 로그 수집에 맞춘다

Falco 출력을 JSON으로 설정하고 stdout으로 내보낸다.

```yaml
falco:
  json_output: true
  buffered_outputs: false
  stdout_output:
    enabled: true
  syslog_output:
    enabled: false
```

JSON output은 CloudWatch Logs, Fluent Bit, OpenSearch, SIEM에서 필드 기반 검색과 알림을 만들기 좋다. stdout만 사용하는 경우 로그 보존은 클러스터 로그 수집 체계에 의존하므로, Falco namespace 로그가 실제로 중앙 수집되는지 반드시 확인한다.

### Step 4: Secret runtime 접근 탐지 rule을 추가한다

custom rule은 다음 Secret 관련 path와 행위를 탐지한다.

```yaml
- list: k8s_secret_mount_prefixes
  items: [/var/run/secrets, /etc/secrets, /run/secrets, /mnt/secrets, /opt/secrets]

- list: k8s_serviceaccount_token_prefixes
  items: [/var/run/secrets/kubernetes.io/serviceaccount]
```

주요 탐지 대상은 다음과 같다.

| Rule | 탐지 목적 |
| --- | --- |
| `Manual Secret File Inspection In Container` | `cat`, `grep`, `base64`, `jq` 같은 도구로 Secret 파일을 직접 읽는 행위 |
| `Read Workload Secret Volume From Container` | ServiceAccount token을 제외한 workload Secret volume read |
| `Read Kubernetes ServiceAccount Token From Container` | projected ServiceAccount token read |
| `Secret Path Discovery In Container` | `ls`, `find`, `stat` 등으로 Secret mount path를 탐색하는 행위 |
| `Process Environment File Read In Container` | `/proc/*/environ` 조회로 env-injected Secret을 훔치려는 행위 |
| `Shell Spawned In Container` | 컨테이너 내부 shell 실행 |

이 rule들은 API 기반 Secret 접근 감사가 보지 못하는 런타임 행위를 탐지한다. 특히 `/proc/*/environ`은 환경변수로 주입된 Secret이 노출될 수 있는 경로이므로 Quick Wins의 `secretKeyRef` 전환 이후에도 중요한 보완 통제다.

### Step 5: 모든 namespace를 감사 대상으로 둔다

PR 테스트는 `falco-test` namespace에서 트리거했지만, 운영 rule은 특정 namespace로 제한하지 않는다. Falco output에는 `k8s.ns.name`, `k8s.pod.name`, `container.name`, `container.image.repository`가 포함되므로, 모든 namespace에서 이벤트를 수집한 뒤 쿼리나 알림에서 namespace별로 필터링한다.

예를 들어 다음 namespace는 잡음이 많을 수 있으므로 별도 기준선을 만든다.

- `kube-system`
- `falco`
- `argocd`
- `external-secrets`
- `ingress-nginx`
- `aws-load-balancer-controller`

하지만 기본 rule에서 처음부터 운영 namespace를 제외하지 않는다. 정상 component의 접근도 기준선을 만드는 데 필요하고, system namespace 침해는 영향이 크기 때문이다.

### Step 6: 테스트 Pod로 runtime Secret 접근 이벤트를 만든다

테스트용 namespace와 Secret, Pod를 만든다.

```bash
kubectl create namespace falco-test

kubectl create secret generic falco-secret-test \
  -n falco-test \
  --from-literal=password='example-password'
```

Secret을 파일로 mount하는 테스트 Pod를 배포한다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: falco-secret-test
  namespace: falco-test
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: app-secret
          mountPath: /etc/secrets
          readOnly: true
  volumes:
    - name: app-secret
      secret:
        secretName: falco-secret-test
```

의도적으로 Falco rule을 트리거한다.

```bash
kubectl exec -n falco-test falco-secret-test -- sh
kubectl exec -n falco-test falco-secret-test -- ls /etc/secrets
kubectl exec -n falco-test falco-secret-test -- cat /etc/secrets/password
kubectl exec -n falco-test falco-secret-test -- cat /var/run/secrets/kubernetes.io/serviceaccount/token
kubectl exec -n falco-test falco-secret-test -- sh -c "cat /proc/1/environ > /dev/null"
```

이 테스트는 실제 운영 Secret 값을 사용하지 않는다. 검증용 더미 Secret만 사용한다.

### Step 7: Falco 로그에서 Secret 접근 이벤트를 확인한다

Falco Pod와 DaemonSet 상태를 확인한다.

```bash
kubectl get pods -n falco -o wide
kubectl get daemonset -n falco
```

custom rule이 ConfigMap에 들어갔는지 확인한다.

```bash
kubectl get configmap -n falco falco-rules -o yaml \
  | rg "Manual Secret File Inspection|Read Workload Secret Volume|Process Environment File Read"
```

Falco 로그에서 이벤트를 찾는다.

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco --since=10m \
  | rg "secret|Secret|Shell|environment|service account"
```

JSON output을 사용하는 경우 `jq`로 rule 이름과 namespace를 확인할 수 있다.

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco --since=10m \
  | jq -r 'select(.rule | test("Secret|ServiceAccount|Environment|Shell")) | [.time, .rule, .priority, .output_fields."k8s.ns.name", .output_fields."k8s.pod.name"] | @tsv'
```

기대 결과:

- `Manual Secret File Inspection In Container`
- `Read Workload Secret Volume From Container`
- `Read Kubernetes ServiceAccount Token From Container`
- `Secret Path Discovery In Container`
- `Process Environment File Read In Container`
- `Shell Spawned In Container`

중 하나 이상이 테스트 행위에 맞게 출력된다.

### Step 8: API 감사와 Falco 이벤트를 함께 해석한다

Falco는 런타임 파일 접근을 탐지하지만, 누가 `kubectl exec`를 실행했는지는 EKS audit log에서 더 잘 보인다. 따라서 Secret 사고 조사 시 다음 순서로 연결한다.

1. Falco 이벤트에서 `k8s.ns.name`, `k8s.pod.name`, `container.name`, `proc.cmdline`, `user.name`을 확인한다.
2. 같은 시간대 EKS audit log에서 `pods/exec`, `pods/attach`, `secrets` 접근 이벤트를 조회한다.
3. authenticator log로 Kubernetes username과 IAM ARN을 연결한다.
4. Secrets Manager 원본 접근이 의심되면 CloudTrail에서 `GetSecretValue`, `BatchGetSecretValue`를 확인한다.
5. 해당 ServiceAccount, RoleBinding, IAM role의 권한 범위를 점검한다.

Falco는 API 감사의 대체재가 아니라 런타임 관측 레이어다. 두 로그를 결합해야 "누가 API로 들어왔고, 어떤 Pod 안에서 어떤 파일을 읽었는지"를 설명할 수 있다.

### Step 9: 알림 튜닝과 예외 처리를 운영화한다

초기 적용 시 Falco는 많은 이벤트를 만들 수 있다. 다음 기준으로 튜닝한다.

- `WARNING` 이상의 Secret 파일 직접 읽기와 `/proc/*/environ` 조회는 우선 알림 대상으로 둔다.
- `Shell Spawned In Container`는 운영 디버깅에서도 발생할 수 있으므로 namespace, 사용자, 시간대 기준으로 분리한다.
- External Secrets Operator, CSI driver, backup agent처럼 Secret 파일을 정상적으로 읽을 수 있는 component는 이미지, namespace, command 기준으로 allowlist를 검토한다.
- allowlist는 rule 전체 비활성화가 아니라 조건을 좁혀 적용한다.
- rule 변경은 Git으로 리뷰하고 테스트 namespace에서 재검증한다.

## 검증 방법

Falco가 모든 노드에 배포되었는지 확인한다.

```bash
kubectl get daemonset -n falco
kubectl get pods -n falco -o wide
```

기대 결과:

- Falco DaemonSet의 desired/current/ready 수가 노드 수와 일치한다.
- Falco Pod가 `Running` 상태다.

Helm release 상태를 확인한다.

```bash
helm status falco -n falco
helm get values falco -n falco
```

기대 결과:

- release 상태가 `deployed`다.
- `json_output: true`가 적용되어 있다.
- custom rule이 values 또는 ConfigMap에 반영되어 있다.

Custom rule이 로드되었는지 확인한다.

```bash
kubectl get configmap -n falco falco-rules -o yaml \
  | rg "Manual Secret File Inspection In Container|Read Workload Secret Volume From Container|Process Environment File Read In Container"
```

기대 결과:

- 추가한 rule 이름이 ConfigMap에 존재한다.

테스트 namespace에서 Secret 파일 접근을 발생시킨다.

```bash
kubectl exec -n falco-test falco-secret-test -- ls /etc/secrets
kubectl exec -n falco-test falco-secret-test -- cat /etc/secrets/password
kubectl exec -n falco-test falco-secret-test -- sh -c "cat /proc/1/environ > /dev/null"
```

Falco 로그를 확인한다.

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco --since=10m \
  | rg "Manual secret file inspection|Workload secret volume read|Process environment file read|Secret path discovery"
```

기대 결과:

- Secret path 탐색 또는 Secret 파일 read 이벤트가 출력된다.
- 출력에 namespace, Pod, container, command, file path가 포함된다.

모든 namespace 기준으로 최근 Secret 관련 Falco 이벤트를 집계한다.

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco --since=30m \
  | jq -r 'select(.tags[]? == "secret") | [.rule, .output_fields."k8s.ns.name", .output_fields."k8s.pod.name"] | @tsv' \
  | sort \
  | uniq -c
```

기대 결과:

- 테스트 이벤트는 `falco-test`에서 확인된다.
- 운영 namespace에서 예상치 못한 Secret read가 있으면 조사 대상으로 분류한다.

EKS audit log와 연결해 `kubectl exec` 주체를 확인한다.

```sql
fields @timestamp, verb, user.username, user.extra.arn.0, objectRef.namespace, objectRef.name, sourceIPs, responseStatus.code
| filter objectRef.resource = "pods"
| filter objectRef.subresource in ["exec", "attach"]
| sort @timestamp desc
| limit 50
```

기대 결과:

- Falco 이벤트 시간대와 가까운 `pods/exec` 요청을 찾을 수 있다.
- 사용자와 IAM ARN을 추적할 수 있다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 이미 침해한 Pod 내부에서 `/etc/secrets/password`를 읽거나 `/proc/1/environ`을 조회해 환경변수 Secret을 탈취하지만, Kubernetes API를 다시 호출하지 않아 audit log에는 Secret 조회 이벤트가 남지 않는다.
- **ServiceAccount token 탈취:** Pod 내부에서 projected token을 읽어 Kubernetes API 접근에 재사용할 수 있다.
- **탐지 공백:** audit/authenticator 로그와 CloudTrail만으로는 컨테이너 내부 파일 read, shell 실행, Secret path 탐색을 충분히 설명하기 어렵다.
- **오탐 및 피로도:** Falco rule을 튜닝하지 않으면 정상 디버깅 shell이나 controller 동작까지 과도하게 알림으로 발생할 수 있다.
- **운영 리스크:** Falco DaemonSet은 노드 권한과 runtime 이벤트 수집 권한이 필요하므로 chart version, 권한, 성능 영향을 관리해야 한다.
- **심각도:** **높음**. 런타임 Secret 접근은 실제 값 탈취 직전 또는 직후의 행위일 수 있으므로 빠른 탐지와 조사 연결이 필요하다.

## 발생 비용

- **AWS 비용 발생 여부 및 예상 규모:** Falco 자체는 오픈소스다. 다만 Falco stdout 로그를 CloudWatch Logs, OpenSearch, SIEM으로 수집하면 저장 및 조회 비용이 발생한다.
- **클러스터 리소스 비용:** Falco DaemonSet이 각 노드에서 CPU, 메모리, 이벤트 처리 리소스를 사용한다. 노드 수와 이벤트량에 따라 requests/limits를 조정해야 한다.
- **운영 비용:** custom rule 튜닝, 예외 관리, 알림 라우팅, 사고 조사 runbook 작성이 필요하다.
- **대안 비용:** 상용 runtime security 플랫폼을 사용하면 대시보드와 탐지 컨텐츠는 풍부하지만 라이선스 비용과 에이전트 운영 부담이 발생할 수 있다.

## 참고 자료
- [Falco official documentation](https://falco.org/docs/)
- [Falco Helm chart](https://github.com/falcosecurity/charts/tree/master/charts/falco)
- [Falco rules](https://falco.org/docs/rules/)
- [Kubernetes Secrets 공식 문서](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes Auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
- [EKS Best Practices Guide - Detective controls](https://aws.github.io/aws-eks-best-practices/security/docs/detective/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  runtime 보안 이벤트, Secret 보호, 감사 로그, 컨테이너 권한 최소화와 연결된다.
- **[NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)**
  runtime 위협 탐지, container exec 통제, Secret 및 ServiceAccount token 보호와 연결된다.
- **[NIST SP 800-53 Rev.5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)**
  `AU-6`, `AU-12`, `SI-4`, `AC-6`과 연결된다.
- **[CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)**
  Secret 접근 권한 최소화와 ServiceAccount token 사용 제한 통제와 연결된다.
- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  detective control, incident response, least privilege 운영 원칙과 연결된다.

## 적용 시 체크리스트

- [ ] Falco가 별도 `falco` namespace에 DaemonSet으로 배포되어 있는가?
- [ ] Falco Helm chart version이 Terraform 변수로 pinning되어 있는가?
- [ ] Falco output이 JSON으로 설정되어 로그 수집 시스템에서 필드 검색 가능한가?
- [ ] PR #130의 Secret 관련 custom rule이 ConfigMap 또는 Helm values에 반영되어 있는가?
- [ ] Secret mount path 직접 read를 탐지하는가?
- [ ] ServiceAccount token read를 탐지하는가?
- [ ] `/proc/*/environ` read를 탐지하는가?
- [ ] Secret path 탐색 명령과 컨테이너 shell 실행을 탐지하는가?
- [ ] Falco 이벤트와 EKS audit log의 `pods/exec`, `secrets` 접근 이벤트를 함께 조사할 수 있는가?
- [ ] 정상 controller 동작과 운영 디버깅으로 인한 오탐 기준이 문서화되어 있는가?
- [ ] Falco 로그가 충분한 기간 보존되고 운영 알림으로 연결되는가?

