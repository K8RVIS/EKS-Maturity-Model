---
title: "Prometheus로 클러스터 메트릭 수집 기반을 구성한다"
description: "클러스터에서 무슨 일이 일어나고 있는지 데이터 없이 파악하는 것은 불가능하다. 공격자가 Pod를 남용하거나, 잘못된 배포가 노드 자원을 잠식하거나, 서비스 계정이 비정상적인 API 호출을 반복해도, 메트릭 수집이 없으면 이를 인지하는 시점은 장애가 발생한 뒤가 된다."
phase: "Quick Wins"
domain: "Pod 보안"
difficulty: "★★☆"
owner: "공통 (전체 실습)"
order: 70
sidebar:
  order: 70
---

## 왜 필요한가

클러스터에서 무슨 일이 일어나고 있는지 데이터 없이 파악하는 것은 불가능하다. 공격자가 Pod를 남용하거나, 잘못된 배포가 노드 자원을 잠식하거나, 서비스 계정이 비정상적인 API 호출을 반복해도, 메트릭 수집이 없으면 이를 인지하는 시점은 장애가 발생한 뒤가 된다.

Prometheus는 클러스터 내부 상태를 시계열 데이터로 수집하는 오픈소스 모니터링 시스템이다. kube-prometheus-stack Helm 차트를 사용하면 Prometheus 본체와 함께 kube-state-metrics, node-exporter가 함께 배포되어 다음 메트릭을 즉시 수집할 수 있다.

- **API 서버 요청률:** `apiserver_request_total` — 비정상적인 4xx/5xx 급증을 탐지한다.
- **Pod 재시작 횟수:** `kube_pod_container_status_restarts_total` — 반복 재시작은 크래시 루프나 OOMKilled 신호다.
- **Pending Pod 수:** `kube_pod_status_phase{phase="Pending"}` — 자원 부족 또는 스케줄링 장애를 나타낸다.
- **ResourceQuota 사용률:** `kube_resourcequota` — 네임스페이스별 CPU/Memory 소진 여부를 파악한다.

이 단계는 이후 단계(Grafana 시각화, 보안 대시보드, AlertManager 알림)의 전제 조건이다. 수집 레이어가 없으면 시각화도, 알림도 동작하지 않는다.

---

## 수행 방법

**사전 조건**

- EKS 클러스터에 `kubectl` 및 `terraform` 접근 권한이 있어야 한다.
- Helm provider가 Terraform에 설정되어 있어야 한다.
- GP3 EBS 스토리지 클래스와 EBS CSI Driver가 클러스터에 설치되어 있어야 한다.

### Step 1: 현황을 파악한다

monitoring 네임스페이스와 kube-prometheus-stack이 이미 설치되어 있는지 확인한다.

```bash
kubectl get namespace monitoring
kubectl get pods -n monitoring
kubectl get helmrelease -n monitoring 2>/dev/null || helm list -n monitoring
```

PVC가 생성되어 있다면 암호화 여부도 확인한다.

```bash
kubectl get pvc -n monitoring
```

### Step 2: Terraform으로 kube-prometheus-stack을 배포한다

`modules/k8s-base/main.tf`에 Prometheus Helm 릴리스를 추가한다. 이 단계에서는 Grafana와 AlertManager는 비활성화하고 Prometheus 메트릭 수집만 활성화한다.

```hcl
resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = var.prometheus_chart_version
  namespace        = var.prometheus_namespace
  create_namespace = true

  values = [yamlencode({
    grafana = {
      enabled = false
    }

    alertmanager = {
      enabled = false
    }

    prometheus = {
      prometheusSpec = {
        retention = "7d"

        resources = {
          requests = { cpu = "250m", memory = "512Mi" }
          limits   = { cpu = "500m", memory = "1Gi" }
        }

        storageSpec = {
          volumeClaimTemplate = {
            spec = {
              storageClassName = "gp3-encrypted"
              accessModes      = ["ReadWriteOnce"]
              resources = {
                requests = { storage = "20Gi" }
              }
            }
          }
        }
      }
    }

    kube-state-metrics = {
      enabled = true
    }

    nodeExporter = {
      enabled = true
    }
  })]
}
```

`modules/k8s-base/variables.tf`에 변수를 추가한다.

```hcl
variable "prometheus_namespace" {
  description = "Prometheus 스택을 배포할 네임스페이스"
  type        = string
  default     = "monitoring"
}

variable "prometheus_chart_version" {
  description = "kube-prometheus-stack Helm 차트 버전"
  type        = string
  default     = "70.4.2"
}
```

`environments/platform/terraform.tfvars`에 값을 설정한다.

```hcl
prometheus_chart_version = "70.4.2"
```

### Step 3: 변경 사항을 적용한다

```bash
terraform init
terraform plan
terraform apply
```

---

## 검증 방법

Prometheus Pod가 정상 기동하는지 확인한다.

```bash
kubectl get pods -n monitoring
```

기대 결과: `kube-prometheus-stack-prometheus-*`, `kube-state-metrics-*`, `node-exporter-*` Pod가 모두 `Running` 상태다.

PVC가 생성되고 암호화된 GP3 스토리지를 사용하는지 확인한다.

```bash
kubectl get pvc -n monitoring
kubectl describe pvc -n monitoring | grep -E "StorageClass|Volume"
```

기대 결과: `storageClassName`이 `gp3-encrypted`, 상태가 `Bound`로 표시된다.

Prometheus가 메트릭을 수집 중인지 포트포워딩으로 확인한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

브라우저에서 `http://localhost:9090`을 열고 다음 쿼리를 실행한다.

```promql
# API 서버 4xx 요청률
sum(rate(apiserver_request_total{code=~"4.."}[5m]))

# Pod 재시작 횟수 (최근 1시간)
sum(increase(kube_pod_container_status_restarts_total[1h])) by (namespace, pod)

# Pending Pod 수
sum(kube_pod_status_phase{phase="Pending"}) by (namespace)

# ResourceQuota CPU 사용률
kube_resourcequota{resource="requests.cpu", type="used"} /
kube_resourcequota{resource="requests.cpu", type="hard"}
```

기대 결과: 각 쿼리가 데이터를 반환하고 그래프가 렌더링된다.

Prometheus가 scrape 대상을 정상 인식하는지 확인한다.

```bash
# Targets 상태 확인 (포트포워딩 상태에서)
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | grep -E '"health"|"job"'
```

기대 결과: `kube-state-metrics`, `node-exporter`, `apiserver` 등의 타겟이 `"health": "up"` 상태로 표시된다.

**검증 완료 기준**

- `monitoring` 네임스페이스의 모든 Pod가 `Running` 상태이다.
- PVC가 `Bound` 상태이고 암호화된 GP3 스토리지를 사용한다.
- Prometheus UI에서 보안 관련 메트릭 쿼리가 데이터를 반환한다.
- kube-state-metrics, node-exporter Scrape 타겟이 `up` 상태이다.

---

## Risk 및 미적용 시 영향

- **탐지 불가:** API 서버에 대한 비정상적인 요청 급증, 반복 재시작하는 Pod, ResourceQuota 초과 직전 상태를 인지할 수단이 없다. 보안 사고는 이미 발생한 뒤에야 파악된다.
- **시각화·알림 불가:** **Grafana 메트릭 시각화**, **보안 메트릭 대시보드 구성**, **AlertManager 보안 알림 구성** 모두 Prometheus 수집 레이어가 없으면 동작하지 않는다. 이후 단계 전체가 무력화된다.
- **운영 리스크:** 메트릭 없이 운영하면 장애 원인 분석에 걸리는 시간이 크게 늘어난다. Pod가 반복 재시작하는 이유, 특정 노드의 자원이 고갈된 원인을 추적할 데이터가 없다.
- **스토리지 미암호화 리스크:** Prometheus PVC가 암호화되지 않은 스토리지를 사용하면 수집된 메트릭 데이터가 평문으로 저장된다. 접근 로그, API 호출 패턴 등 민감한 운영 정보가 노출될 수 있다.
- **심각도:** **중간**. 메트릭 수집 자체가 공격을 막지는 않지만, 탐지 수단이 없으면 이후 단계의 모든 보안 모니터링 체계가 동작하지 않는다.

---

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| AWS 추가 비용 | Prometheus PVC용 EBS GP3 스토리지 비용 발생 (20Gi 기준 약 월 $2) |
| 도구 비용 | kube-prometheus-stack은 오픈소스로 추가 비용 없음 |
| 운영 고려사항 | Prometheus 데이터 보존 기간(retention)을 7일로 설정했다. 장기 보존이 필요하면 Thanos 또는 Amazon Managed Service for Prometheus(AMP) 연동을 검토한다. |

---

## 참고 자료

- [kube-prometheus-stack Helm Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
- [Prometheus - Storage](https://prometheus.io/docs/prometheus/latest/storage/)
- [kube-state-metrics - Exposed Metrics](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/workload/pod-metrics.md)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Detecting security issues](https://docs.aws.amazon.com/eks/latest/best-practices/detective.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  클러스터 활동에 대한 감사 및 모니터링을 활성화하고, API 서버 접근 로그와 리소스 사용량을 지속적으로 수집할 것을 권고한다. Prometheus + kube-state-metrics 조합은 이 요건의 메트릭 수집 부분을 충족한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  클러스터 내 비정상적인 활동 탐지를 위해 메트릭과 로그를 중앙에서 수집하도록 권고한다. Pod 재시작, API 요청 급증, 리소스 고갈 징후는 모두 이 단계에서 수집되는 메트릭으로 감지할 수 있다.
- **AWS EKS Best Practices**
  Amazon Managed Service for Prometheus(AMP) 또는 자체 Prometheus 스택을 사용해 클러스터 메트릭을 수집하고, 이상 징후 탐지를 위한 기반을 구축하도록 권장한다.


## 적용 시 체크리스트

- [ ] `monitoring` 네임스페이스의 모든 Pod가 `Running` 상태인가?
- [ ] Prometheus PVC가 `Bound` 상태이고 암호화된 GP3 스토리지를 사용하는가?
- [ ] Prometheus UI에서 `apiserver_request_total`, `kube_pod_container_status_restarts_total` 등 보안 메트릭 쿼리가 데이터를 반환하는가?
- [ ] kube-state-metrics, node-exporter Scrape 타겟이 `up` 상태인가?
- [ ] Grafana와 AlertManager가 이 단계에서는 비활성화되어 있는가?

---
