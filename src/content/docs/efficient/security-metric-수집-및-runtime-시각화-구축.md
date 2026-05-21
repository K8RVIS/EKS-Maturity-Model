---
title: "Security Metric 수집 및 Runtime 시각화를 구축한다"
description: "**Grafana 메트릭 시각화** 단계에서 Grafana를 연결했지만, 기본 대시보드는 범용 인프라 메트릭을 보여줄 뿐이다. 보안 관점에서 실제로 의미 있는 질문은 다르다."
phase: "Efficient"
domain: "Pod 보안"
difficulty: "★★★"
owner: "장해윤"
order: 60
sidebar:
  order: 60
---

## 왜 필요한가

**Grafana 메트릭 시각화** 단계에서 Grafana를 연결했지만, 기본 대시보드는 범용 인프라 메트릭을 보여줄 뿐이다. 보안 관점에서 실제로 의미 있는 질문은 다르다.

- API 서버에 대한 4xx 오류가 급증하고 있는가? (인증 실패, 권한 오류 반복 시도)
- 특정 Pod가 짧은 시간 안에 반복 재시작하고 있는가? (크래시 루프, OOMKilled, 이상 종료)
- Pending 상태의 Pod가 쌓이고 있는가? (자원 고갈, 노드 압박)
- 팀 네임스페이스의 CPU/Memory ResourceQuota가 한계에 근접했는가?

이 단계에서는 PromQL 쿼리를 작성하고 Grafana ConfigMap으로 대시보드를 자동 프로비저닝해 위 질문에 대한 답을 즉시 볼 수 있는 보안 대시보드를 구성한다.

Grafana Sidecar는 `grafana_dashboard: "1"` 레이블이 붙은 ConfigMap을 자동으로 감지해 대시보드를 Grafana에 등록한다. 따라서 대시보드 JSON을 ConfigMap으로 관리하면 Terraform apply만으로 대시보드 변경이 반영된다.

---

## 수행 방법

**사전 조건**

- **Grafana 메트릭 시각화**(Grafana + Prometheus)가 배포되어 있어야 한다.
- Grafana Sidecar 설정에서 `label: grafana_dashboard`가 활성화되어 있어야 한다.

### Step 1: 현황을 파악한다

Grafana Sidecar가 활성화되어 있는지, 기존 보안 대시보드 ConfigMap이 있는지 확인한다.

```bash
kubectl get configmap -n monitoring | grep grafana
kubectl describe deployment -n monitoring kube-prometheus-stack-grafana | grep -A5 sidecar
```

### Step 2: 보안 대시보드 ConfigMap을 작성한다

`modules/k8s-base/main.tf`에 대시보드 ConfigMap 리소스를 추가한다. Grafana Sidecar가 이 ConfigMap을 자동으로 감지해 대시보드를 등록한다.

```hcl
resource "kubernetes_config_map" "grafana_security_dashboard" {
  metadata {
    name      = "grafana-security-dashboard"
    namespace = var.prometheus_namespace
    labels = {
      grafana_dashboard = "1"
    }
  }

  data = {
    "security-overview.json" = file("${path.module}/dashboards/security-overview.json")
  }

  depends_on = [helm_release.kube_prometheus_stack]
}
```

### Step 3: 보안 대시보드 JSON을 작성한다

`modules/k8s-base/dashboards/security-overview.json`에 6개 패널을 구성한다. 각 패널의 PromQL 쿼리와 임계값은 아래와 같다.

**패널 1: API Server 4xx 요청률**

```promql
sum(rate(apiserver_request_total{code=~"4.."}[5m])) by (code, verb)
```

인증 실패(401), 권한 오류(403), 존재하지 않는 리소스(404) 등 4xx 오류 급증은 무차별 접근 시도나 잘못된 서비스 계정 사용 신호다.

**패널 2: API Server 요청률 (verb별)**

```promql
sum(rate(apiserver_request_total[5m])) by (verb)
```

`LIST`, `WATCH`, `GET`의 비정상적인 급증은 서비스 계정 토큰을 탈취한 공격자가 클러스터 내부를 정찰하는 패턴일 수 있다.

**패널 3: 네임스페이스별 Pod 재시작 횟수 (1시간)**

```promql
sum(increase(kube_pod_container_status_restarts_total[1h])) by (namespace, pod)
```

Pod 반복 재시작은 OOMKilled(메모리 한도 초과), 애플리케이션 크래시, 보안 컨텍스트 위반으로 인한 강제 종료를 나타낼 수 있다.

**패널 4: Pending Pod 수**

```promql
sum(kube_pod_status_phase{phase="Pending"}) by (namespace)
```

임계값: 1개 이상 → 주의(노란색), 3개 이상 → 위험(빨간색)

**패널 5: ResourceQuota CPU 사용률**

```promql
kube_resourcequota{resource="requests.cpu", type="used"} /
kube_resourcequota{resource="requests.cpu", type="hard"} * 100
```

임계값: 70% 초과 → 주의(노란색), 90% 초과 → 위험(빨간색)

**패널 6: ResourceQuota Memory 사용률**

```promql
kube_resourcequota{resource="requests.memory", type="used"} /
kube_resourcequota{resource="requests.memory", type="hard"} * 100
```

임계값: 70% 초과 → 주의(노란색), 90% 초과 → 위험(빨간색)

### Step 4: 변경 사항을 적용한다

```bash
terraform plan
terraform apply
```

---

## 검증 방법

ConfigMap이 올바른 레이블로 생성되었는지 확인한다.

```bash
kubectl get configmap -n monitoring grafana-security-dashboard -o jsonpath='{.metadata.labels}'
```

기대 결과: `{"grafana_dashboard":"1"}` 레이블이 포함되어 있다.

Grafana Sidecar가 ConfigMap을 감지해 대시보드를 등록했는지 확인한다.

```bash
kubectl logs -n monitoring -l app.kubernetes.io/name=grafana -c grafana-sc-dashboard | tail -20
```

기대 결과: ConfigMap 감지 및 대시보드 등록 로그가 출력된다.

Grafana UI에서 대시보드 목록을 확인한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
```

브라우저에서 `http://localhost:3000 → Dashboards → Browse`를 열고 `EKS Security Overview` 대시보드가 있는지 확인한다.

각 패널이 데이터를 반환하는지 PromQL로 직접 검증한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

Prometheus UI(`http://localhost:9090`)에서 아래 쿼리를 실행한다.

```promql
# 4xx 오류 확인
sum(rate(apiserver_request_total{code=~"4.."}[5m])) by (code)

# Pending Pod 확인
sum(kube_pod_status_phase{phase="Pending"}) by (namespace)

# ResourceQuota 사용률
kube_resourcequota{resource="requests.cpu", type="used"} / kube_resourcequota{resource="requests.cpu", type="hard"}
```

기대 결과: 각 쿼리가 데이터를 반환한다.

**검증 완료 기준**

- `grafana-security-dashboard` ConfigMap이 `grafana_dashboard=1` 레이블로 생성되어 있다.
- Grafana UI에 보안 대시보드가 자동 등록되어 있다.
- 6개 패널이 모두 데이터를 표시한다.
- ResourceQuota 패널의 임계값(70%/90%)이 게이지에 반영되어 있다.

---

## Risk 및 미적용 시 영향

- **이상 탐지 지연:** 기본 대시보드만으로는 API 서버 4xx 급증, Pod 반복 재시작 같은 보안 이상 패턴을 즉시 인식하기 어렵다. 문제 발생 후 수동으로 로그를 뒤져야 한다.
- **쿼리 불일치:** **AlertManager 보안 알림 구성** 단계의 AlertManager 알림 규칙은 이 단계의 PromQL 쿼리와 동일한 임계값을 기준으로 동작한다. 대시보드와 알림 기준이 다르면 운영 혼선이 발생한다.
- **ConfigMap 없이 수동 관리:** 대시보드를 Grafana UI에서 직접 만들면 Terraform 상태와 분리되어 재배포 시 초기화된다. ConfigMap 기반 관리가 재현 가능성을 보장한다.
- **심각도:** **중간**. 대시보드 부재가 즉각적인 보안 위협은 아니지만, 탐지 반응 시간을 크게 늘려 사고 대응 효율을 저하시킨다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 플랫폼/DevSecOps 담당자 (쿼리 설계 및 임계값 튜닝) |
| AWS 추가 비용 | 없음 (ConfigMap은 Kubernetes 내장 리소스) |
| 도구 비용 | 없음 |
| 운영 고려사항 | 임계값(70%/90%)은 초기값이다. 실제 워크로드 패턴을 관찰한 뒤 조직 상황에 맞게 조정한다. PromQL 쿼리는 클러스터 규모나 네임스페이스 구조 변경 시 함께 검토해야 한다. |

---

## Assessment 체크리스트

- [ ] `grafana-security-dashboard` ConfigMap이 `grafana_dashboard=1` 레이블로 생성되어 있는가?
- [ ] Grafana UI에 보안 대시보드가 자동 등록되어 있는가?
- [ ] API Server 4xx 요청률 패널이 데이터를 표시하는가?
- [ ] Pod 재시작 횟수 패널이 네임스페이스별로 표시되는가?
- [ ] ResourceQuota CPU/Memory 패널의 임계값(70%/90%)이 게이지에 반영되어 있는가?
- [ ] Pending Pod 패널이 임계값(1개/3개)에 따라 색상이 변하는가?

---

## 참고 자료

- [Prometheus - PromQL query examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [Grafana - Dashboard JSON model](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/)
- [Grafana - Sidecar for dashboards](https://github.com/grafana/helm-charts/tree/main/charts/grafana#sidecar-for-dashboards)
- [kube-state-metrics - Pod metrics](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/workload/pod-metrics.md)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Detecting security issues](https://docs.aws.amazon.com/eks/latest/best-practices/detective.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  API 서버 접근 감사, 비정상적인 요청 패턴 탐지, 리소스 사용량 모니터링을 권고한다. 이 단계의 6개 패널은 이 요건을 시각화 레이어에서 구현한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  클러스터 내 비정상 활동(과도한 API 호출, Pod 반복 재시작, 리소스 고갈)을 실시간으로 탐지하는 모니터링 체계를 요구한다. 각 패널의 PromQL 쿼리는 이 지침에서 언급하는 탐지 시나리오에 직접 대응한다.
- **AWS EKS Best Practices**
  Grafana와 kube-state-metrics를 활용해 API 서버 요청 패턴, Pod 상태, 리소스 할당량을 시각화하고 이상 탐지 대시보드를 운영하도록 권장한다.

