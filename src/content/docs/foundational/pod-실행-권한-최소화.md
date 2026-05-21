---
title: "네임스페이스에 PSS Baseline을 적용하고 비준수 Pod 실행을 차단한다"
description: "Kubernetes Pod Security Standards(PSS)는 Pod의 보안 수준을 세 단계(Privileged, Baseline, Restricted)로 정의하는 내장 정책 프레임워크다. PSS는 Admission Controller가 Pod 생성·수정 요청"
phase: "Foundational"
domain: "Pod 보안"
difficulty: "★☆☆"
owner: "공통 (전체 실습)"
order: 110
sidebar:
  order: 110
---

## 왜 필요한가

Kubernetes Pod Security Standards(PSS)는 Pod의 보안 수준을 세 단계(Privileged, Baseline, Restricted)로 정의하는 내장 정책 프레임워크다. PSS는 Admission Controller가 Pod 생성·수정 요청을 받을 때 네임스페이스 레이블을 참조해 정책을 적용한다.

PSS 레이블이 없으면 Admission Controller는 어떤 검증도 수행하지 않는다. 즉, `privileged: true`, `hostNetwork: true`, `hostPID: true` 같이 노드 권한을 획득할 수 있는 설정이 포함된 Pod가 아무 제약 없이 실행된다.

PSS Baseline은 알려진 권한 상승 경로를 차단하면서 대부분의 워크로드를 수용하는 균형 잡힌 기준이다.

- **enforce:** 기준을 위반하는 Pod 실행을 즉시 거부한다.
- **audit:** 위반 시 API 서버 감사 로그에 기록한다(실행은 허용).
- **warn:** 위반 시 kubectl에 경고 메시지를 출력한다(실행은 허용).

세 모드를 함께 설정하면 enforce로 즉각 차단하면서 audit과 warn으로 위반 내역을 추적·확인할 수 있다.

---

## 수행 방법

**사전 조건**

- EKS 클러스터 v1.25 이상이어야 한다(PSS는 Kubernetes 1.25에서 GA 승격).
- 네임스페이스를 관리하는 Terraform 모듈에 접근할 수 있어야 한다.

### Step 1: 현황을 파악한다

팀 네임스페이스에 PSS 레이블이 설정되어 있는지 확인한다.

```bash
kubectl get namespace team-a -o jsonpath='{.metadata.labels}' | jq
```

`pod-security.kubernetes.io/enforce` 키가 없으면 PSS가 비활성 상태다. 이 경우 `privileged: true` Pod도 제한 없이 실행된다.

### Step 2: Terraform으로 PSS Baseline 레이블을 적용한다

`modules/namespaces/main.tf`의 네임스페이스 레이블에 PSS 설정을 추가한다.

```hcl
resource "kubernetes_namespace_v1" "teams" {
  for_each = toset(var.team_names)

  metadata {
    name = each.value
    labels = {
      "app.kubernetes.io/part-of"                  = var.project_name
      "training.k8rvis.io/team"                    = each.value
      "pod-security.kubernetes.io/enforce"         = "baseline"
      "pod-security.kubernetes.io/enforce-version" = "latest"
      "pod-security.kubernetes.io/audit"           = "baseline"
      "pod-security.kubernetes.io/audit-version"   = "latest"
      "pod-security.kubernetes.io/warn"            = "baseline"
      "pod-security.kubernetes.io/warn-version"    = "latest"
    }
  }
}
```

`enforce-version`을 `latest`로 설정하면 클러스터 버전이 업그레이드될 때 자동으로 최신 PSS 기준을 따른다. 변경 후 `terraform apply`로 적용한다.

### Step 3: 워크로드 securityContext를 PSS Baseline에 맞춘다

PSS Baseline enforce 모드에서 금지되는 주요 설정은 다음과 같다.

| 금지 설정 | 이유 |
| --- | --- |
| `securityContext.privileged: true` | 노드 전체 권한 획득 가능 |
| `hostNetwork: true` | 호스트 네트워크 네임스페이스 공유 |
| `hostPID: true` / `hostIPC: true` | 호스트 프로세스/IPC 네임스페이스 공유 |
| `hostPath` 볼륨 마운트 | 노드 파일시스템 직접 접근 |

기존 워크로드(web, api, db)의 `training.k8rvis.io/security-baseline` 레이블을 `baseline`으로 갱신하고, api 워크로드는 `automountServiceAccountToken: false`로 변경한다.

---

## 검증 방법

PSS Baseline이 privileged Pod를 차단하는지 확인한다.

```bash
kubectl run test-privileged \
  --image=nginx \
  --overrides='{"spec":{"containers":[{"name":"c","image":"nginx","securityContext":{"privileged":true}}]}}' \
  -n team-a \
  --restart=Never
```

기대 결과:

```
Error from server (Forbidden): pods "test-privileged" is forbidden:
violates PodSecurity "baseline:latest": privileged
(container "c" must not set securityContext.privileged=true)
```

모든 팀 네임스페이스에 레이블이 적용되었는지 확인한다.

```bash
kubectl get namespaces -l 'pod-security.kubernetes.io/enforce=baseline' \
  -o custom-columns='NAME:.metadata.name,ENFORCE:.metadata.labels.pod-security\.kubernetes\.io/enforce'
```

**검증 완료 기준**

- 모든 팀 네임스페이스에 `pod-security.kubernetes.io/enforce=baseline` 레이블이 설정되어 있다.
- `privileged: true` Pod 생성 시 `Forbidden` 오류로 즉시 거부된다.
- 기존 워크로드(web, api, db)가 PSS Baseline 하에서 정상 동작한다.

---

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 컨테이너 취약점을 이용해 임의 코드를 실행한 뒤, `privileged: true` 또는 `hostPID: true` Pod를 생성해 노드 전체 권한을 획득한다. 이후 노드에 마운트된 다른 Pod의 Secret, 서비스 계정 토큰, etcd 데이터에 접근한다.
- **횡적 이동 시나리오:** `hostNetwork: true` Pod를 통해 노드의 네트워크 인터페이스에 직접 접근하고, VPC 내부 트래픽을 스니핑하거나 내부 서비스에 대한 네트워크 정찰을 수행한다.
- **운영 리스크:** PSS 없이 운영 중인 클러스터에 뒤늦게 enforce를 적용하면 기존 워크로드가 일괄 거부될 수 있다. audit과 warn 모드를 먼저 활성화해 위반 항목을 파악한 뒤 적용해야 한다.
- **영향 범위:** 노드 권한 탈취, 타 네임스페이스 Pod 데이터 접근, 클러스터 전체 침해로의 확산
- **심각도:** **높음**. PSS 없이는 공격자가 단일 컨테이너 취약점에서 노드 전체 권한까지 상승하는 경로가 열려 있다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| AWS 추가 비용 | PSS는 Kubernetes 내장 기능으로 추가 비용 없음 |
| 도구 비용 | 없음 |
| 운영 고려사항 | 기존 클러스터에 enforce를 처음 적용할 때는 audit/warn 모드를 먼저 활성화해 위반 워크로드를 파악한 뒤 enforce로 전환한다. |

---

## Assessment 체크리스트

- [ ] 모든 팀 네임스페이스에 `pod-security.kubernetes.io/enforce=baseline` 레이블이 설정되어 있는가?
- [ ] `privileged: true` Pod 생성이 거부되는가?
- [ ] 기존 운영 워크로드가 PSS Baseline 기준에서 정상 실행되는가?

---

## 참고 자료

- [Kubernetes - Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kubernetes - Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [AWS EKS - Implement Pod Security Standards](https://docs.aws.amazon.com/eks/latest/best-practices/pod-security.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  Pod Security Admission Controller를 활성화하고, 프로덕션 네임스페이스에 적절한 PSS 레벨을 적용하도록 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너를 root가 아닌 사용자로 실행하고, 권한 상승을 허용하지 않으며, 필요하지 않은 Linux capability를 제거하도록 권고한다. PSS Baseline은 이 지침의 기본 요건을 자동으로 강제한다.
- **AWS EKS Best Practices**
  모든 네임스페이스에 PSS 레이블을 설정해 Privileged 설정을 가진 워크로드의 실행을 제한하고, 감사 로그와 함께 운영할 것을 권장한다.

