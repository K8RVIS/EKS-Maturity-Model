---
title: "AlertManager 및 보안 알림 규칙을 추가한다"
description: "**보안 메트릭 대시보드 구성** 단계에서 구성한 대시보드는 운영자가 직접 화면을 보고 있어야 이상 징후를 인식할 수 있다. 하지만 보안 이벤트는 새벽, 주말, 휴가 중에도 발생한다. 대시보드만으로는 실시간 대응이 불가능하다."
phase: "Efficient"
domain: "Pod 보안"
difficulty: "★★☆"
owner: "장해윤"
order: 50
sidebar:
  order: 50
---

## 왜 필요한가

**보안 메트릭 대시보드 구성** 단계에서 구성한 대시보드는 운영자가 직접 화면을 보고 있어야 이상 징후를 인식할 수 있다. 하지만 보안 이벤트는 새벽, 주말, 휴가 중에도 발생한다. 대시보드만으로는 실시간 대응이 불가능하다.

AlertManager는 Prometheus가 수집한 메트릭을 기준으로 정의된 조건(PrometheusRule)이 충족되면 자동으로 알림을 발송한다. 담당자가 대시보드를 보지 않아도 임계값을 초과하는 순간 알림이 도달한다.

이 단계에서 자동화하는 알림 규칙은 **보안 메트릭 대시보드 구성** 대시보드의 임계값과 동일한 기준을 사용한다. 시각화와 알림이 같은 기준으로 동작해야 운영 혼선이 없다.

| PrometheusRule | 보안 메트릭 대시보드 패널 | 역할 |
| --- | --- | --- |
| `HighAPIServer4xxRate` | API Server 4xx 요청률 | 4xx 요청 5 req/s 초과 시 알림 |
| `HighPodRestartCount` | Pod 재시작 횟수 | 1시간 내 5회 이상 재시작 시 알림 |
| `TooManyPendingPods` | Pending Pod 수 | 3개 이상 Pending 시 알림 |
| `HighCPUQuotaUsage` | ResourceQuota CPU 사용률 | CPU 할당량 90% 초과 시 알림 |
| `HighMemoryQuotaUsage` | ResourceQuota Memory 사용률 | Memory 할당량 90% 초과 시 알림 |

---

## 수행 방법

**사전 조건**

- **보안 메트릭 대시보드 구성** 단계가 배포되어 있어야 한다.
- `monitoring.coreos.com/v1` PrometheusRule CRD가 클러스터에 등록되어 있어야 한다(kube-prometheus-stack 설치 시 자동 등록).
- AlertManager가 보낼 알림 수신처(이메일, Slack 등)를 준비해야 한다.

### Step 1: 현황을 파악한다

AlertManager가 현재 비활성화 상태인지 확인한다.

```bash
kubectl get pods -n monitoring | grep alertmanager
kubectl get prometheusrule -n monitoring
```

AlertManager가 없거나 PrometheusRule이 없으면 이 단계를 진행한다.

### Step 2: AlertManager를 활성화한다

`modules/k8s-base/main.tf`의 kube-prometheus-stack Helm 릴리스에서 AlertManager를 활성화한다.

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
      enabled       = true
      adminPassword = var.grafana_admin_password

      persistence = {
        enabled          = true
        storageClassName = "gp3-encrypted"
        size             = "5Gi"
      }

      sidecar = {
        dashboards = {
          enabled = true
          label   = "grafana_dashboard"
        }
      }

      ingress = {
        enabled          = true
        ingressClassName = "nginx"
        hosts            = ["grafana.${var.cluster_name}.local"]
      }
    }

    alertmanager = {
      enabled = true

      alertmanagerSpec = {
        storage = {
          volumeClaimTemplate = {
            spec = {
              storageClassName = "gp3-encrypted"
              accessModes      = ["ReadWriteOnce"]
              resources = {
                requests = { storage = "2Gi" }
              }
            }
          }
        }
      }
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

    kube-state-metrics = { enabled = true }
    nodeExporter        = { enabled = true }
  })]
}
```

### Step 3: PrometheusRule로 보안 알림 규칙을 정의한다

`modules/k8s-base/alert-rules.tf`를 신규 생성한다.

```hcl
resource "kubernetes_manifest" "security_alert_rules" {
  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "PrometheusRule"
    metadata = {
      name      = "eks-security-alerts"
      namespace = var.prometheus_namespace
      labels    = { release = "kube-prometheus-stack" }
    }
    spec = {
      groups = [{
        name = "eks-security"
        rules = [
          {
            alert = "HighAPIServer4xxRate"
            expr  = "sum(rate(apiserver_request_total{code=~\"4..\"}[5m])) > 5"
            for   = "2m"
            labels      = { severity = "warning" }
            annotations = {
              summary     = "API 서버 4xx 오류율 급증"
              description = "API 서버 4xx 요청이 5 req/s를 초과했습니다. 인증 실패 또는 무차별 접근 시도를 확인하세요."
            }
          },
          {
            alert = "HighPodRestartCount"
            expr  = "sum(increase(kube_pod_container_status_restarts_total[1h])) by (namespace, pod) > 5"
            for   = "5m"
            labels      = { severity = "warning" }
            annotations = {
              summary     = "Pod 반복 재시작 감지"
              description = "{{ $labels.namespace }}/{{ $labels.pod }} Pod가 1시간 내 5회 이상 재시작했습니다."
            }
          },
          {
            alert = "TooManyPendingPods"
            expr  = "sum(kube_pod_status_phase{phase=\"Pending\"}) by (namespace) >= 3"
            for   = "5m"
            labels      = { severity = "critical" }
            annotations = {
              summary     = "Pending Pod 다수 발생"
              description = "{{ $labels.namespace }} 네임스페이스에 Pending 상태 Pod가 3개 이상입니다. 자원 고갈 또는 노드 압박을 확인하세요."
            }
          },
          {
            alert = "HighCPUQuotaUsage"
            expr  = "kube_resourcequota{resource=\"requests.cpu\",type=\"used\"} / kube_resourcequota{resource=\"requests.cpu\",type=\"hard\"} > 0.9"
            for   = "5m"
            labels      = { severity = "warning" }
            annotations = {
              summary     = "CPU ResourceQuota 90% 초과"
              description = "{{ $labels.namespace }} 네임스페이스의 CPU 할당량 사용률이 90%를 초과했습니다."
            }
          },
          {
            alert = "HighMemoryQuotaUsage"
            expr  = "kube_resourcequota{resource=\"requests.memory\",type=\"used\"} / kube_resourcequota{resource=\"requests.memory\",type=\"hard\"} > 0.9"
            for   = "5m"
            labels      = { severity = "warning" }
            annotations = {
              summary     = "Memory ResourceQuota 90% 초과"
              description = "{{ $labels.namespace }} 네임스페이스의 Memory 할당량 사용률이 90%를 초과했습니다."
            }
          }
        ]
      }]
    }
  }

  depends_on = [helm_release.kube_prometheus_stack]
}
```

### Step 4: 변경 사항을 적용한다

```bash
terraform plan
terraform apply
```

---

## 검증 방법

AlertManager Pod와 PVC가 정상 생성되었는지 확인한다.

```bash
kubectl get pods -n monitoring | grep alertmanager
kubectl get pvc -n monitoring | grep alertmanager
```

기대 결과: AlertManager Pod가 `Running` 상태이고 PVC가 `Bound`(gp3-encrypted)다.

PrometheusRule이 등록되었는지 확인한다.

```bash
kubectl get prometheusrule -n monitoring
kubectl describe prometheusrule eks-security-alerts -n monitoring
```

기대 결과: `eks-security-alerts` PrometheusRule이 등록되어 있다.

Prometheus가 알림 규칙을 정상 로드했는지 확인한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

Prometheus UI(`http://localhost:9090 → Alerts`)에서 5개 알림 규칙이 `inactive` 또는 `pending` 상태로 표시되는지 확인한다.

AlertManager UI에서 알림 수신 상태를 확인한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093
```

브라우저에서 `http://localhost:9093`을 열어 AlertManager가 정상 동작하는지 확인한다.

알림 발화를 직접 테스트한다. 아래 쿼리를 Prometheus에서 실행해 현재 값과 임계값을 비교한다.

```bash
# 현재 Pending Pod 수 확인 (TooManyPendingPods 규칙)
curl -s "http://localhost:9090/api/v1/query?query=sum(kube_pod_status_phase{phase=\"Pending\"})%20by%20(namespace)" | python3 -m json.tool

# ResourceQuota CPU 사용률 확인 (HighCPUQuotaUsage 규칙)
curl -s "http://localhost:9090/api/v1/query?query=kube_resourcequota{resource=\"requests.cpu\",type=\"used\"}%20/%20kube_resourcequota{resource=\"requests.cpu\",type=\"hard\"}" | python3 -m json.tool
```

**검증 완료 기준**

- AlertManager Pod가 `Running` 상태이고 PVC가 `Bound`(gp3-encrypted)다.
- `eks-security-alerts` PrometheusRule이 등록되어 있다.
- Prometheus Alerts UI에서 5개 규칙이 모두 표시된다.
- AlertManager UI(`http://localhost:9093`)에 접근 가능하다.

---

## Risk 및 미적용 시 영향

- **사각지대 발생:** 대시보드만 있고 알림이 없으면 운영자가 자리를 비운 사이 발생한 이상 징후를 놓친다. 보안 이벤트 대응 시간이 크게 늘어난다.
- **임계값 불일치:** **보안 메트릭 대시보드 구성**과 **AlertManager 보안 알림 구성** 단계의 임계값이 다르면 대시보드에서는 정상으로 표시되지만 알림이 발송되거나, 반대로 대시보드에서 위험이 보이지만 알림이 오지 않는 상황이 발생한다. 이 단계에서는 두 기준을 동일하게 유지한다.
- **알림 피로(Alert Fatigue):** 임계값이 너무 낮으면 알림이 과다 발생해 담당자가 알림을 무시하게 된다. `for` 필드로 지속 시간 조건을 설정해 일시적 스파이크는 무시하고 지속적인 이상만 알린다.
- **AlertManager 미구성:** AlertManager가 배포되어 있어도 수신처(receiver)가 설정되지 않으면 알림이 발송되지 않는다. 이 단계에서 수신처 설정까지 완료해야 한다.
- **심각도:** **높음**. 알림 없는 모니터링은 사후 분석 도구에 그친다. 실시간 대응을 위해 반드시 AlertManager와 알림 규칙이 함께 구성되어야 한다.

---

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 플랫폼/DevSecOps 담당자 (알림 규칙 설계, 임계값 튜닝, 수신처 관리) |
| AWS 추가 비용 | AlertManager PVC용 EBS GP3 스토리지 비용 발생 (2Gi 기준 약 월 $0.2). 이메일 알림은 SNS 연동 시 추가 비용 가능 |
| 도구 비용 | AlertManager는 오픈소스. PagerDuty, OpsGenie 등 상용 On-Call 도구 연동 시 별도 비용 발생 |
| 운영 고려사항 | 초기에는 알림이 과다 발생할 수 있다. `for` 지속 시간과 임계값을 실제 워크로드 패턴에 맞게 조정하고, 알림 그룹화(grouping)와 억제(inhibit) 규칙을 설정해 알림 피로를 방지한다. |

---

## 참고 자료

- [Prometheus - Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [AlertManager - Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Prometheus Operator - PrometheusRule](https://prometheus-operator.dev/docs/api-reference/api/#monitoring.coreos.com/v1.PrometheusRule)
- [kube-prometheus-stack - AlertManager](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack#alertmanager)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Detecting security issues](https://docs.aws.amazon.com/eks/latest/best-practices/detective.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  클러스터 이상 징후에 대한 자동 알림 체계를 갖추고, 보안 이벤트 발생 시 즉각적인 대응이 가능하도록 운영 프로세스를 구성할 것을 권고한다. PrometheusRule은 이 요건의 자동화 레이어를 담당한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  지속적인 모니터링과 이상 탐지 자동화를 요구하며, 운영자가 자리를 비운 상황에서도 보안 이벤트를 감지하고 대응할 수 있는 체계를 갖추도록 권고한다.
- **AWS EKS Best Practices**
  Prometheus AlertManager와 연동해 임계값 기반 알림을 구성하고, SNS, PagerDuty, Slack 등 외부 수신처와 통합해 실시간 대응 체계를 갖추도록 권장한다.


## 적용 시 체크리스트

- [ ] AlertManager Pod가 `Running` 상태이고 PVC가 `Bound`(gp3-encrypted)인가?
- [ ] `eks-security-alerts` PrometheusRule이 등록되어 있는가?
- [ ] Prometheus Alerts UI에서 5개 규칙(`HighAPIServer4xxRate`, `HighPodRestartCount`, `TooManyPendingPods`, `HighCPUQuotaUsage`, `HighMemoryQuotaUsage`)이 모두 표시되는가?
- [ ] **보안 메트릭 대시보드 구성** 임계값과 PrometheusRule 임계값이 일치하는가?
- [ ] AlertManager 수신처(receiver)가 설정되어 알림이 실제 발송되는가?

---
