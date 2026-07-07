---
title: "Runtime 위협탐지"
description: "Seccomp 프로파일은 허용되지 않은 syscall을 **사전에 차단**하는 자물쇠 역할을 한다. 하지만 허용된 syscall 범위 안에서 공격자가 수행하는 행위는 Seccomp만으로 탐지할 수 없다. 예를 들어 컨테이너 내에서 셸을 실행하거나, `/etc/passw"
phase: "Optimized"
domain: "Pod 보안"
order: 70
sidebar:
  order: 70
---

## 왜 필요한가

Seccomp 프로파일은 허용되지 않은 syscall을 **사전에 차단**하는 자물쇠 역할을 한다. 하지만 허용된 syscall 범위 안에서 공격자가 수행하는 행위는 Seccomp만으로 탐지할 수 없다. 예를 들어 컨테이너 내에서 셸을 실행하거나, `/etc/passwd`를 읽거나, `/etc` 디렉토리에 파일을 쓰는 행위는 모두 허용된 syscall 범위 안에서 일어난다.

Falco는 클러스터 모든 노드에 DaemonSet으로 배포되어 eBPF를 통해 커널 syscall을 실시간으로 감시한다. 정의된 탐지 룰에 매칭되는 행위가 발생하면 즉시 이벤트를 기록하고 알림을 발송한다.

- **Seccomp이 하는 것:** 허용 목록 외 syscall 사전 차단
- **Falco가 하는 것:** 허용된 syscall 안에서 일어나는 의심 행위를 실시간 감지

두 계층이 함께 동작해야 정적 차단과 동적 탐지가 모두 커버된다.

eBPF 드라이버(`modern_ebpf`)를 선택한 이유는 Amazon Linux 2/2023 환경에서 커널 헤더를 설치하지 않아도 동작하며, Graviton(aarch64) 노드를 지원하기 때문이다.

---

## 수행 방법

**사전 조건**

- EKS 클러스터에 Helm provider가 설정되어 있어야 한다.
- Falco가 eBPF 모드로 동작하므로 노드 커널 버전 4.14 이상이어야 한다 (Amazon Linux 2/2023 기본 충족).

### Step 1: 현황을 파악한다

Falco가 이미 배포되어 있는지 확인한다.

```bash
kubectl get pods -n falco
kubectl get helmrelease -n falco 2>/dev/null || helm list -n falco
```

Falco 없이 민감 파일 접근이 탐지되지 않는지 테스트한다.

```bash
# Falco 미설치 상태에서 실행 → 탐지 로그 없음
kubectl exec -it <any-pod> -n team-a -- cat /etc/shadow 2>/dev/null || echo "파일 없음(정상)"
kubectl logs -n falco -l app.kubernetes.io/name=falco 2>/dev/null || echo "Falco 미설치 확인"
```

### Step 2: Terraform으로 Falco를 배포한다

`modules/k8s-base/main.tf`에 Falco Helm 릴리스를 추가한다.

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

  values = [yamlencode({
    driver = {
      kind = "modern_ebpf"
    }

    falco = {
      json_output                  = true
      json_include_output_property = true
      log_stderr                   = true
      priority                     = "notice"
      stdout_output = {
        enabled = true
      }
    }

    customRules = {
      "k8rvis_rules.yaml" = file("${path.module}/falco/k8rvis_rules.yaml")
    }
  })]
}
```

`modules/k8s-base/variables.tf`에 변수를 추가한다.

```hcl
variable "falco_namespace" {
  description = "Falco를 배포할 네임스페이스"
  type        = string
  default     = "falco"
}

variable "falco_chart_version" {
  description = "Falco Helm 차트 버전. null이면 최신 버전을 사용한다."
  type        = string
  default     = null
}
```

### Step 3: 커스텀 탐지 룰을 작성한다

`modules/k8s-base/falco/k8rvis_rules.yaml`을 신규 생성한다.

```yaml
- rule: Shell spawned in container
  desc: 컨테이너 내에서 셸이 실행되었다. 공격자의 컨테이너 진입 또는 내부 침해 시도를 나타낼 수 있다.
  condition: >
    spawned_process and container
    and proc.name in (bash, sh, dash, zsh, ash, fish)
    and not proc.pname in (runc, containerd-shim, docker-init)
  output: >
    셸이 컨테이너 내에서 실행됨
    (user=%user.name user_loginuid=%user.loginuid
     pod=%k8s.pod.name ns=%k8s.ns.name
     container=%container.id image=%container.image.repository
     cmd=%proc.cmdline pname=%proc.pname)
  priority: WARNING
  tags: [container, shell, k8rvis]

- rule: Write below etc in container
  desc: 컨테이너 내에서 /etc 디렉토리 하위에 쓰기가 시도되었다. 설정 파일 변조 또는 백도어 설치 시도일 수 있다.
  condition: >
    open_write and container
    and fd.name startswith /etc
    and not proc.name in (sed, groupadd, useradd, usermod)
  output: >
    /etc 디렉토리 하위 쓰기 시도 감지
    (user=%user.name user_loginuid=%user.loginuid
     pod=%k8s.pod.name ns=%k8s.ns.name
     container=%container.id image=%container.image.repository
     file=%fd.name cmd=%proc.cmdline)
  priority: WARNING
  tags: [container, filesystem, k8rvis]

- rule: Sensitive file read in container
  desc: 컨테이너 내에서 민감한 시스템 파일이 읽혔다. 자격증명 탈취 시도를 나타낼 수 있다.
  condition: >
    open_read and container
    and fd.name in (/etc/shadow, /etc/passwd, /etc/sudoers)
    and not proc.name in (passwd, shadow, login, sshd)
  output: >
    민감 파일 읽기 감지 (CRITICAL)
    (user=%user.name user_loginuid=%user.loginuid
     pod=%k8s.pod.name ns=%k8s.ns.name
     container=%container.id image=%container.image.repository
     file=%fd.name cmd=%proc.cmdline)
  priority: CRITICAL
  tags: [container, credentials, k8rvis]
```

### Step 4: 변경 사항을 적용한다

```bash
terraform plan
terraform apply
```

---

## 검증 방법

Falco DaemonSet이 모든 노드에 배포되었는지 확인한다.

```bash
kubectl get pods -n falco -o wide
kubectl get daemonset -n falco
```

기대 결과: 모든 노드에 Falco Pod가 `Running` 상태로 배포된다.

커스텀 룰이 정상 로드되었는지 확인한다.

```bash
kubectl logs -n falco -l app.kubernetes.io/name=falco | grep -E "k8rvis|Loading rules"
```

기대 결과: `k8rvis_rules.yaml` 룰이 로드되었다는 로그가 출력된다.

민감 파일 접근 탐지를 테스트한다.

```bash
# 테스트 Pod 생성
kubectl run falco-test --image=ubuntu --restart=Never -n team-a -- sleep 3600
kubectl wait --for=condition=ready pod/falco-test -n team-a

# /etc/shadow 읽기 시도 (CRITICAL 이벤트 발생)
kubectl exec -it falco-test -n team-a -- cat /etc/shadow

# Falco 로그에서 탐지 이벤트 확인
kubectl logs -n falco -l app.kubernetes.io/name=falco | grep "민감 파일 읽기"
```

기대 결과: `CRITICAL` 우선순위로 민감 파일 읽기 이벤트가 JSON 형식으로 기록된다.

셸 실행 탐지를 테스트한다.

```bash
kubectl exec -it falco-test -n team-a -- bash -c "echo test"

# 탐지 이벤트 확인
kubectl logs -n falco -l app.kubernetes.io/name=falco | grep "셸이 컨테이너 내에서 실행됨"
```

기대 결과: `WARNING` 우선순위로 셸 실행 이벤트가 기록된다.

테스트 Pod를 정리한다.

```bash
kubectl delete pod falco-test -n team-a
```

**검증 완료 기준**

- Falco DaemonSet이 모든 노드에서 `Running` 상태이다.
- `k8rvis_rules.yaml` 커스텀 룰 3개가 Falco에 로드되어 있다.
- `/etc/shadow` 읽기 시도 시 `CRITICAL` 이벤트가 JSON으로 기록된다.
- 컨테이너 내 셸 실행 시 `WARNING` 이벤트가 기록된다.

---

## Risk 및 미적용 시 영향

- **침해 후 행위 탐지 불가:** Seccomp, PSS, Kyverno 등 사전 차단 체계가 구성되어 있어도 허용된 syscall 범위 안에서 공격자가 수행하는 행위는 탐지할 수 없다. Falco 없이는 공격자가 컨테이너에 진입해 `/etc/shadow`를 읽거나 셸을 실행해도 인지할 방법이 없다.
- **포렌식 데이터 부재:** 보안 사고 발생 후 공격자의 행동 경로를 재구성할 런타임 이벤트 데이터가 없다. Falco의 JSON 출력은 **Cluster 감사 추적 및 Event Logging 체계 구축** 단계의 감사 로그와 함께 포렌식 증거를 구성한다.
- **eBPF 드라이버 요건:** `modern_ebpf` 드라이버는 커널 버전 4.14 이상을 요구한다. 구형 커널을 사용하는 노드에서는 드라이버를 `kmod`(커널 모듈)으로 변경해야 하며, 이 경우 커널 헤더 설치가 필요하다.
- **심각도:** **높음**. 런타임 탐지 없이는 침해가 진행 중인 상황을 실시간으로 인지할 수 없다.

---

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 장해윤 |
| AWS 추가 비용 | 없음 (클러스터 내 오픈소스 배포) |
| 도구 비용 | Falco OSS는 무료. Falco Cloud 또는 상용 SIEM 연동 시 별도 비용 발생 |
| 운영 고려사항 | 커스텀 룰의 오탐(false positive) 발생 시 예외 조건(`not proc.name in (...)`)을 추가해 노이즈를 줄인다. 기본 Falco 룰셋은 유지하고 `customRules`로만 프로젝트 특화 룰을 추가하는 방식을 권장한다. |

---

## 참고 자료

- [Falco - Getting started](https://falco.org/docs/getting-started/)
- [Falco - Custom rules](https://falco.org/docs/rules/)
- [Falco - eBPF driver](https://falco.org/docs/event-sources/kernel/ebpf/)
- [Falco Helm Chart](https://github.com/falcosecurity/charts/tree/master/charts/falco)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Runtime security](https://docs.aws.amazon.com/eks/latest/best-practices/runtime.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  클러스터 런타임 활동을 모니터링하고 비정상적인 컨테이너 행위(셸 실행, 민감 파일 접근, 예상치 못한 네트워크 연결 등)를 탐지하는 체계를 갖출 것을 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  런타임 탐지 체계를 통해 컨테이너가 의도한 동작 범위를 벗어나는 시점을 실시간으로 감지하도록 요구한다. Falco의 커스텀 룰은 이 지침의 런타임 이상 탐지 요건을 이행한다.
- **AWS EKS Best Practices**
  eBPF 기반 런타임 탐지 도구를 EKS 클러스터에 적용해 침해 후 행위를 실시간으로 감지하고, 감사 로그와 연동해 사고 대응 체계를 구축하도록 권장한다.


## 적용 시 체크리스트

- [ ] Falco DaemonSet이 모든 노드에서 `Running` 상태인가?
- [ ] `k8rvis_rules.yaml` 커스텀 룰 3개(Shell spawned, Write below etc, Sensitive file read)가 로드되어 있는가?
- [ ] `/etc/shadow` 읽기 시도 시 `CRITICAL` 이벤트가 JSON으로 기록되는가?
- [ ] 컨테이너 내 셸 실행 시 `WARNING` 이벤트가 기록되는가?
- [ ] Falco 드라이버가 `modern_ebpf`로 설정되어 Graviton 노드를 지원하는가?

---
